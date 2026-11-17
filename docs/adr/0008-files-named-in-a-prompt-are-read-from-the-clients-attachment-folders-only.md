# 8. Files named in a prompt are read from the client's attachment folders only

Date: 2026-11-17

## Context

ADR 0007 has the adapter read a file because a line of the prompt's text names it in T3 Code's
wording, and send it to Claude Science. It noted that pasted text in that wording has the same
effect. With no limit on the path, such a line can name any file the user can read: a key, a
credentials file, a document of another project. The file then goes to the project and into the
conversation, without the user having attached anything.

T3 Code saves every attachment in one place: `attachments` in its state folder, which is
`userdata` (or `dev`, for a development build) in its home folder. The home folder is `.t3` in
the user's home folder unless `T3CODE_HOME` names another. This was read from the program code
of T3 Code 0.1.9.

## Decision

- A file named in a prompt's text is read only when it lies in `userdata/attachments` or
  `dev/attachments` of T3 Code's home folder: the one `T3CODE_HOME` names, or `.t3` in the
  user's home folder.
- Links are followed before the comparison, so a path cannot leave the folder through `..` or
  a symbolic link.
- A line that names a file anywhere else stays in the message as text, like a line whose file
  cannot be read.

## Consequences

- Pasted text can at most name a file the user attached in T3 Code at some time.
- A T3 Code started with another home folder needs `T3CODE_HOME` in the provider's environment,
  or its files are passed on as their lines again. Images still arrive, as blocks.
- Another client that saves attachments and names them in the same wording is not served.
  Revisit when one turns up.
