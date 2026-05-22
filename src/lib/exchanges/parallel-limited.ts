/** Выполняет async-задачи с ограничением параллелизма (чтобы не упереться в rate limit). */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const cap = Math.max(1, Math.floor(limit));
  const out: R[] = new Array(items.length);
  let idx = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }

  const n = Math.min(cap, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}
