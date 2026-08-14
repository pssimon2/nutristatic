// Prototype WASM search kernel: the best-first trie walk (pop, node parse,
// DFA transition, push, restart) ported to freestanding C. The index bytes
// and a dense DFA table live in linear memory; results return to JS one at
// a time for dedup/emission. Measurement rig only — not wired into the app.
//
// Build: clang --target=wasm32-unknown-unknown -O3 -nostdlib \
//   -Wl,--no-entry -Wl,--export-dynamic -Wl,--allow-undefined \
//   -o kernel.wasm kernel.c

typedef unsigned char u8;
typedef unsigned int u32;
typedef int i32;
typedef unsigned long long u64;
typedef double f64;

#define NSYM 37
#define NO_NODE 0xFFFFFFFFu

extern u8 __heap_base;
static u32 heap_top = 0;

__attribute__((export_name("walloc"))) u32 walloc(u32 n) {
  if (heap_top == 0) heap_top = (u32)&__heap_base;
  u32 p = (heap_top + 15) & ~15u;
  heap_top = p + n;
  return p;
}

// ---- configured by init() ----
static u8 *idx;
static u32 idx_len;
static i32 *dfa;      // nstates * NSYM, -1 = dead
static u8 *accepting; // nstates
static i32 sym[256];
static u8 alphabet[NSYM];
static f64 total;
static f64 restart;
static u32 root;

// frontier (4-ary max-heap, SoA)
static i32 *f_crumb, *f_state;
static u8 *f_ch;
static f64 *f_scale, *f_count, *f_pri;
static u32 *f_next;
static u32 f_size, f_cap;

// crumbs
static i32 *c_parent;
static u8 *c_ch;
static u32 c_len, c_cap;

// io block: [0]=steps u32, [4]=out_len u32, [8]=out_score f64, [16..] text
static u8 *io;

__attribute__((export_name("init"))) void init(
    u32 idx_ptr, u32 idx_len_, u32 dfa_ptr, u32 nstates, u32 acc_ptr,
    u32 alpha_ptr, f64 restart_, u32 f_cap_, u32 c_cap_, u32 io_ptr) {
  idx = (u8 *)idx_ptr;
  idx_len = idx_len_;
  dfa = (i32 *)dfa_ptr;
  accepting = (u8 *)acc_ptr;
  restart = restart_;
  io = (u8 *)io_ptr;
  (void)nstates;
  u8 *alpha = (u8 *)alpha_ptr;
  for (int i = 0; i < 256; ++i) sym[i] = -1;
  for (int i = 0; i < NSYM; ++i) {
    alphabet[i] = alpha[i];
    sym[alpha[i]] = i;
  }
  f_cap = f_cap_;
  c_cap = c_cap_;
  f_crumb = (i32 *)walloc(f_cap * 4);
  f_state = (i32 *)walloc(f_cap * 4);
  f_ch = (u8 *)walloc(f_cap);
  f_scale = (f64 *)walloc(f_cap * 8);
  f_count = (f64 *)walloc(f_cap * 8);
  f_pri = (f64 *)walloc(f_cap * 8);
  f_next = (u32 *)walloc(f_cap * 4);
  c_parent = (i32 *)walloc(c_cap * 4);
  c_ch = (u8 *)walloc(c_cap);
  f_size = 0;
  c_len = 0;
  root = idx_len;
}

static void heap_set(u32 i, u32 j) {
  f_crumb[i] = f_crumb[j];
  f_state[i] = f_state[j];
  f_ch[i] = f_ch[j];
  f_scale[i] = f_scale[j];
  f_count[i] = f_count[j];
  f_pri[i] = f_pri[j];
  f_next[i] = f_next[j];
}

static int heap_push(i32 crumb, i32 state, u8 ch, f64 scale, f64 count,
                     u32 next) {
  if (f_size >= f_cap) return 0;
  u32 i = f_size++;
  f64 pri = count * scale;
  while (i > 0) {
    u32 parent = (i - 1) >> 2;
    if (f_pri[parent] >= pri) break;
    heap_set(i, parent);
    i = parent;
  }
  f_crumb[i] = crumb;
  f_state[i] = state;
  f_ch[i] = ch;
  f_scale[i] = scale;
  f_count[i] = count;
  f_pri[i] = pri;
  f_next[i] = next;
  return 1;
}

// popped-entry registers
static i32 topCrumb, topState;
static u8 topCh;
static f64 topScale, topCount;
static u32 topNext;

static void heap_pop(void) {
  topCrumb = f_crumb[0];
  topState = f_state[0];
  topCh = f_ch[0];
  topScale = f_scale[0];
  topCount = f_count[0];
  topNext = f_next[0];
  u32 last = --f_size;
  if (last == 0) return;
  f64 pri = f_pri[last];
  u32 i = 0;
  for (;;) {
    u32 c0 = 4 * i + 1;
    if (c0 >= last) break;
    u32 m = c0;
    f64 mp = f_pri[c0];
    u32 cEnd = c0 + 4 < last ? c0 + 4 : last;
    for (u32 c = c0 + 1; c < cEnd; ++c) {
      if (f_pri[c] > mp) {
        m = c;
        mp = f_pri[c];
      }
    }
    if (mp <= pri) break;
    heap_set(i, m);
    i = m;
  }
  heap_set(i, last);
}

// children scratch
#define MAXCH 300
static u8 t_ch[MAXCH];
static f64 t_count[MAXCH];
static u32 t_next[MAXCH];
static u32 t_n;

// Returns leftover count (phrases terminating at the node).
static f64 parse_children(u32 n, f64 count) {
  t_n = 0;
  if (n == NO_NODE) return count;
  u32 num = idx[--n];
  if (num >= 0x20 && num < 0x80) {
    t_ch[0] = (u8)num;
    t_count[0] = count;
    t_next[0] = n;
    t_n = 1;
    return 0;
  }
  u32 count_size = num < 0xC0 ? 1 : num < 0xE0 ? 2 : 8;
  u32 offset_size = num < 0x20 ? 0 : num < 0xA0 ? 1 : num < 0xE0 ? 2 : 8;
  num &= 0x1F;
  if (num == 0) num = idx[--n];
  u32 size = count_size + offset_size + 1;
  u32 start = n - num * size;
  for (u32 p = start; p < n; p += size) {
    u8 ch = idx[p];
    f64 ccount;
    if (count_size == 1) {
      ccount = idx[p + 1];
    } else if (count_size == 2) {
      ccount = (f64)(idx[p + 1] | ((u32)idx[p + 2] << 8));
    } else {
      ccount = 0;
      f64 mul = 1;
      for (u32 j = 0; j < 8; ++j) {
        ccount += (f64)idx[p + 1 + j] * mul;
        mul *= 256.0;
      }
    }
    u32 next;
    if (offset_size == 0) {
      next = NO_NODE;
    } else if (offset_size == 1) {
      u32 off = idx[p + 1 + count_size];
      next = off == 0xFF ? NO_NODE : start - off;
    } else if (offset_size == 2) {
      u32 off = idx[p + count_size + 1] | ((u32)idx[p + count_size + 2] << 8);
      next = off == 0xFFFF ? NO_NODE : start - off;
    } else {
      // 8-byte offsets: our indexes are < 4GB, so the high half is zero
      // unless it's the all-ones sentinel.
      u32 lo = 0;
      int ones = 1;
      f64 mul = 1;
      f64 offf = 0;
      for (u32 j = 0; j < 8; ++j) {
        u8 b = idx[p + 1 + count_size + j];
        if (b != 0xFF) ones = 0;
        offf += (f64)b * mul;
        mul *= 256.0;
      }
      lo = (u32)offf;
      next = ones ? NO_NODE : start - lo;
    }
    t_ch[t_n] = ch;
    t_count[t_n] = ccount;
    t_next[t_n] = next;
    ++t_n;
    count -= ccount;
  }
  return count;
}

__attribute__((export_name("seed"))) void seed(i32 startState, f64 total_) {
  total = total_;
  f_size = 0;
  c_len = 0;
  heap_push(-1, startState, 0, 1.0, total, root);
}

// run(budget): 0 = budget exhausted, 1 = result in io block, 2 = frontier
// empty (done), 3 = capacity overflow (prototype limit).
__attribute__((export_name("run"))) i32 run(u32 budget) {
  u32 steps = 0;
  u32 *io_steps = (u32 *)io;
  u32 *io_len = (u32 *)(io + 4);
  f64 *io_score = (f64 *)(io + 8);
  u8 *io_text = io + 16;
  while (steps < budget) {
    if (f_size == 0) {
      *io_steps = steps;
      return 2;
    }
    heap_pop();
    ++steps;
    f64 leftover = parse_children(topNext, topCount);
    (void)leftover;
    u32 newCrumb = c_len;
    for (u32 i = 0; i < t_n; ++i) {
      i32 sy = sym[t_ch[i]];
      i32 s2 = sy < 0 ? -1 : dfa[(u32)topState * NSYM + (u32)sy];
      if (s2 >= 0) {
        if (c_len == newCrumb) {
          if (c_len >= c_cap) {
            *io_steps = steps;
            return 3;
          }
          c_parent[c_len] = topCrumb;
          c_ch[c_len] = topCh;
          ++c_len;
        }
        if (!heap_push((i32)newCrumb, s2, t_ch[i], topScale, t_count[i],
                       t_next[i])) {
          *io_steps = steps;
          return 3;
        }
      }
    }
    if (accepting[topState] && topCrumb != -1) {
      u32 len = 0;
      for (i32 i = topCrumb; i >= 0; i = c_parent[i]) ++len;
      if (len > 500) len = 500;
      io_text[len - 1] = topCh;
      u32 pos = len - 1;
      for (i32 i = topCrumb; i >= 0 && pos > 0; i = c_parent[i]) {
        io_text[--pos] = c_ch[i];
      }
      *io_len = len;
      *io_score = topScale * topCount;
      *io_steps = steps;
      return 1;
    }
    if (restart > 0.0 && topCh == 0x20 && topNext != root) {
      f64 scale = topScale * topCount / total * restart;
      if (scale > 0) {
        if (!heap_push(topCrumb, topState, 0x20, scale, total, root)) {
          *io_steps = steps;
          return 3;
        }
      }
    }
  }
  *io_steps = steps;
  return 0;
}
