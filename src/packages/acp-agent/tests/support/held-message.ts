import type { ScienceCli } from "../../../science-daemon/index.ts";
import type { FakeScienceDaemon } from "../../../science-daemon/testing.ts";
import { gate } from "./gate.ts";

/** A way to keep a message on its way to the fake daemon for as long as a test needs. */
export interface HeldMessage {
  /** The Science CLI stand-in to run the adapter with. */
  readonly scienceCli: ScienceCli;
  /**
   * Makes the next message take a detour: the daemon turns it away because the login expired,
   * and the login link the adapter then asks for is held back. Call it once the session is open.
   */
  holdNextMessage(): void;
  /** Settles once a message has been sent and turned away, and waits for the login link. */
  readonly onItsWay: Promise<void>;
  /** Hands out the login link, after which the message is sent again and accepted. */
  release(): void;
}

export function heldMessage(fake: FakeScienceDaemon): HeldMessage {
  const onItsWay = gate();
  const loginLink = gate();
  let holding = false;
  return {
    async scienceCli(args) {
      if (args[0] === "url" && holding) {
        onItsWay.open();
        await loginLink.opened;
      }
      return fake.scienceCli(args);
    },
    holdNextMessage() {
      fake.expireLogins();
      holding = true;
    },
    onItsWay: onItsWay.opened,
    release: () => loginLink.open(),
  };
}
