# 6. A reply names a file by its full path when the tools tell where it is

Date: 2026-11-16

## Context

Claude Science names the files it writes relative to the folder it works in: "saved as
`analysis/reports/summary.md`". That folder is one the user gave it access to, anywhere on the
machine. The session's folder is another one: the folder linked to the project, which often
holds nothing but the marker file.

A client turns a path in a reply into a link and resolves it against the session's folder. T3
Code then reports that the file cannot be read. The daemon does not say which folder a
conversation works in: a project has none, and the folders the user granted
(`GET /preferences/host-grants`) are often several levels above the one the path is relative to.

The tools, however, are given full paths, as an argument or inside their code, and give full
paths back.

## Decision

- A session remembers the folders named in what its conversation's tools were given and gave
  back, and the folders above them.
- A code span of a reply that is a relative path to exactly one file below those folders is
  sent with the file's full path in place of the relative one. The same is done for the replies
  of a conversation's history.
- Everything else passes as it is: a path the session's own folder has, a path that fits no file
  or more than one, text outside code spans, and code blocks.
- Reply text is held back only from the start of a code span to its end.

## Consequences

- The link opens in any client, whatever folder the session is in. Verified in T3 Code 0.1.9.
- The reply a client shows differs from the one Claude Science wrote, in those code spans.
- Each relative path costs one look at the disk per remembered folder, once per session. The
  number of folders is capped.
- Nothing is found for a daemon on another machine, or for a file the tools never named a
  folder of. The reply is then passed as written.
- Paths are read as POSIX paths. Windows paths in a tool's input are not recognised.
