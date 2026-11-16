# 7. Attachments are uploaded to the project, also those a client names by path

Date: 2026-11-16

## Context

FR-A12 asks that a message can carry images and files. The daemon's web client does this in two
steps: it uploads each file to the project, then names it in front of the message's text by a
line of JSON (see "Attachments" in `docs/protocol.md`). The daemon turns an image named that way
into an image the model sees, and tells the model how to read any other file.

ACP gives a client three ways to send a file: an `image` block, an embedded `resource` block, and
a `resource_link`. T3 Code 0.1.9, read from its program code, uses them like this for an agent of
this kind:

- It saves every attachment on the user's computer and adds a line to the prompt's text:
  `[Attached image "<name>" is saved at: <path>]` or `[Attached file ...]`, with ` (text extracted
  to: <path>)` before the bracket closes when it also extracted the file's text.
- It sends an image as an `image` block as well, but only to an agent that declares
  `promptCapabilities.image`. To any other agent it refuses the whole turn ("ACP driver did not
  negotiate image prompt support").
- It never sends an embedded `resource`.

Claude Science runs its tools in a sandbox that cannot read the folder T3 Code saves to, so the
path alone is of no use to it.

## Decision

- The adapter declares `image` and `embeddedContext`, and uploads the content of `image` and
  `resource` blocks as attachments.
- It also reads the files that a prompt's text names in T3 Code's wording, uploads them, and
  drops their lines. A line whose file cannot be read stays as it is. An `image` block with the
  same bytes as a file named this way is not uploaded a second time.
- A `resource_link` is still sent as its address and not uploaded.
- Every file goes out in one request. The daemon's upload in pieces is not used.
- `audio` stays undeclared and refused.

## Consequences

- Attaching a file in T3 Code works for images and for every other kind of file, under the name
  the user gave it.
- The adapter reads a file from the user's computer because a line of the prompt names it. The
  prompt comes from the user's own client and the file goes to the user's own daemon on
  loopback, but text pasted into a prompt in exactly that wording would have the same effect.
- The wording is T3 Code's and can change with any release: when it does, its lines are passed
  on as text again and only images still arrive, as blocks. Revisit when T3 Code sends files as
  embedded resources, or offers a way to tell which agent wants what.
- An attachment stays with the project, as one attached in the Claude Science app does.
- A file larger than the daemon takes in one request is refused with the daemon's own reason.
  The web client switches to the upload in pieces above 45 MiB; a single request of 50 MiB was
  accepted by daemon 0.1.72, and T3 Code sends no file larger than that.
