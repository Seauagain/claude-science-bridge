/** A point where a test holds something back, such as a reply script, until it says go. */
export interface Gate {
  /** Settles once {@link Gate.open} was called. */
  readonly opened: Promise<void>;
  open(): void;
}

export function gate(): Gate {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}
