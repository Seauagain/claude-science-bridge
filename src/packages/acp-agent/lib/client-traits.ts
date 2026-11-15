/**
 * What csbridge does differently for a client because of how that client behaves. Every entry
 * says which behaviour it answers; nothing here is a matter of taste.
 */
export interface ClientTraits {
  /**
   * Offer the model as an option like any other instead of as the session's model.
   *
   * T3 Code accepts a change of a thread's model only while a session is bound to the thread,
   * and unbinds the session when the thread is settled or archived. A thread that was settled,
   * or imported and not used yet, can therefore not change its model at all, and a message
   * sent with another model is refused with it. A change of any other option is always
   * accepted and applied when the next turn starts.
   */
  readonly modelIsPlainOption: boolean;
}

/** The traits of the client that named itself `clientName` when it initialized. */
export function clientTraits(clientName: string | undefined): ClientTraits {
  // T3 Code's sessions, its provider probe and its session listing all carry this prefix.
  return { modelIsPlainOption: clientName?.startsWith("t3-code") === true };
}
