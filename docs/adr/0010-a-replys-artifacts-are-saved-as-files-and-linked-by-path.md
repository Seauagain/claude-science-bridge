# 10. A reply's artifacts are saved as files and linked by their paths

Date: 2026-11-22

## Context

Claude Science shows a figure it made as a Markdown image whose destination is a marker:
`![Phase diagram]({{artifact:<version id>}})`. Its own page turns the marker into the address
the daemon serves the file at. An ACP client knows nothing of the marker. T3 Code shows the
image as one without an address, `![Phase diagram]()`, and the figure is lost.

The address is of no use to a client either: the daemon serves the file only to a request that
carries its login. What every client can show is a file on the computer, named by its full
path, which is how T3 Code tells its own agents to embed an image.

The daemon keeps the file in its data folder, but says where only for an upload, and how that
folder is laid out is its own business.

## Decision

- A Markdown link or image whose destination is an artifact marker is sent with the path of a
  file in place of the marker, in a reply and in a conversation's history alike.
- The file is a copy: the adapter fetches the version from the daemon
  (`GET /artifacts/versions/<version id>`) and saves it as
  `<state folder>/artifacts/<version id>/<file name>`. A version never changes, so a saved one
  is used as it is and fetched once, by whichever adapter process needs it first.
- A marker anywhere else passes as written: in code that reads the artifact it is the daemon's
  to resolve.
- A marker whose file cannot be had also passes as written, and the reply goes on: the daemon
  has no such version or cannot be reached, the file is longer than 64 MiB, or it cannot be
  written.
- Reply text is held back only from where such a link may have begun to where it ends.

## Consequences

- Figures show in a thread in any client that shows an image by its path.
- The state folder now holds content of the user's conversations, not identifiers only, and
  grows with every figure shown. Nothing removes the copies; deleting
  `<state folder>/artifacts` is safe, and what is shown again is fetched again.
- The first showing of a figure waits for one request to the daemon.
- Nothing is read from or written to the Claude Science data folder.
- The reply a client shows differs from the one Claude Science wrote, in those links.
