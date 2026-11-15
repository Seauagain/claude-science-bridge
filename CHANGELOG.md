# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- `csbridge acp`: an ACP agent that fronts the local Claude Science daemon. A session belongs to
  the project its working folder is linked to; its first prompt starts a conversation there and
  later prompts continue it. Replies stream as message chunks. A reply can be cancelled. Several
  sessions can run at once.
- Recovery: an expired login is renewed, a dropped event connection is reopened with backoff, a
  reply interrupted by a drop is completed from the conversation's messages, and replies end with
  a clear error when the daemon stays away.
- `csbridge projects` and `csbridge link` to link a folder to a Claude Science project.
- `csbridge link --all <folder>` creates a linked sub-folder for every project, with folder names
  that are valid on macOS, Linux and Windows.
- `csbridge doctor` to check the setup, and the same actionable messages when a session cannot be
  opened.
- `--claude-science-bin` and `CLAUDE_SCIENCE_BIN` to choose the `claude-science` executable;
  `CSBRIDGE_START_COMMAND` to name the command that starts Claude Science on this machine.

- Every request to the daemon has a time limit (30 s), so a daemon that accepts connections but
  does not answer cannot hang a prompt.
- A cancelled prompt always answers `cancelled`: also when the turn fails or the cancel cannot be
  delivered, when the message had not been sent yet (it is then not sent), and when the daemon
  does not end the turn within 10 s.
- The project link is the marker file `.csbridge/project.json` in the linked folder.

Tested against Claude Science 0.1.53.
