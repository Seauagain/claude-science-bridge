# 5. Tool calls are titled with Claude Science's description and carry no kind

Date: 2026-11-15

## Context

ACP lets an agent give a tool call a `title` and a `kind` (`read`, `edit`, `execute`, `search`,
...). Claude Science records, with nearly every tool use, a short description of what the tool is
doing, written for the user: "Fitting the dose-response curve". Its own UI titles the tool use
with it.

T3 Code, the client this adapter is mostly used with, replaces the title of a call whose kind it
knows with a label of its own: "Ran command" for `execute`, "Read file" for `read`, "Changed
files" for the edit kinds. It builds those labels from `rawInput.command` or a path. Claude
Science's tools do not name their arguments that way (`python` takes `code`), so most calls
would read "Ran command". A call without a kind keeps its title.

T3 Code also derives the label again from every update on its own: an update that carries
`content` and no title renames the call to "Tool". And for a call without a kind it shows text
`content` as JSON, but a `rawOutput` that is a string as text.

## Decision

- A tool call is titled with Claude Science's description, or with the tool's name when there is
  none, and is sent without a `kind`.
- Every update of a tool call repeats the title.
- A tool's output is sent twice, as `content` (what ACP defines for it) and as a `rawOutput`
  string.

## Consequences

- In T3 Code a tool call reads as it does in Claude Science, and can be opened to see the input
  and the output as text.
- A client that picks an icon by kind shows the same icon for every tool. Mapping tool names to
  kinds would also put a list of the daemon's tools into the ACP package, to be kept up to date
  with Claude Science.
- The output crosses the connection twice. It is local, and a client keeps one of the two.
- Revisit when T3 Code stops replacing titles, or when another client needs the kind.
