export class LruCache<T> {
  private readonly items = new Map<string, T>();

  constructor(private readonly capacity: number) {}

  get(key: string) {
    const value = this.items.get(key);
    if (value === undefined) return undefined;
    this.items.delete(key);
    this.items.set(key, value);
    return value;
  }

  set(key: string, value: T) {
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.capacity) {
      const oldest = this.items.keys().next().value as string | undefined;
      if (!oldest) break;
      if (oldest === key && this.items.size > 1) {
        this.items.delete(oldest);
        this.items.set(oldest, value);
        continue;
      }
      this.items.delete(oldest);
    }
  }

  has(key: string) {
    return this.items.has(key);
  }
}
