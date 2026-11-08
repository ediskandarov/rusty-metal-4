export function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Missing or invalid UI element: ${id}`);
  return node;
}

export function item<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`Invalid item index: ${index}`);
  return value;
}
