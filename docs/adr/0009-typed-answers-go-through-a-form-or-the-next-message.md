# 9. An answer the user types goes through a form, or is the user's next message

Date: 2026-11-18

## Context

Some of what the daemon asks the user takes text and not a pick: a contact email address
(`contact_email`), and a question with more than one pick or more than one question (`ask`).
Until now the adapter only said in the thread that such a request has to be answered in Claude
Science. A user in T3 Code met "Claude Science is waiting for a contact email address. This
client cannot give it" and had to change applications to go on.

ACP has one way to ask for text: a form (elicitation) with a field of type `string`. T3 Code
0.1.9 declares forms and shows such a field as a text input (read from its program code). A
client without forms has permission requests only, which offer buttons.

The daemon wants the user to have read a notice before giving a contact email, and records the
notice with the decision. Besides the address the request takes two other answers: declining
for good, and deciding later.

## Decision

- A request of these kinds has a typed answer, and its other answers are choices whose
  identifiers are words: `decline`, `skip`. What the user types is one of those words or the
  answer itself, in a form's field as in a message.
- In a client that shows forms the request is a form with one text field. The daemon's notice
  is written to the thread first, because a form's question is one line. What is typed and is
  no answer brings the form up again. A declined form is the request's refusal that the daemon
  does not remember (`skip`), never the lasting one. A closed form leaves the request pending.
- In any other client the request is written to the thread and the prompt ends as `end_turn`
  while the daemon's turn stays stopped. The user's next message is the answer: it is not sent
  to Claude Science as a message, and what a client adds after the user's own words (T3 Code
  ends every prompt with a note about itself) is left out by reading the prompt's first text
  only. A message that is no answer is answered with what to send.
- Requests with a typed answer are settled before the turn's requests with choices, so that
  nothing has been picked when a prompt ends to wait for a message.
- Passwords and API keys (`credential_request`, `ssh_password`) stay with Claude Science: a
  thread keeps what is typed into it. `provider_discovery` stays there too until its response
  is known.

## Consequences

- A contact email can be given, declined or put off without leaving the client.
- In a client without forms a message sent while such a request waits is taken as its answer.
  The thread says so when it asks, and `skip` frees the conversation for other messages.
- The wire format of `contact_email` was read from the daemon's program code and not observed.
  If the daemon refuses an answer, the prompt fails with the daemon's reason and the request
  stays pending, to be answered in Claude Science.
- Several requests with typed answers in one turn, in a client without forms, are answered one
  message at a time, and the answers before the last go to the daemon ahead of it. The daemon's
  web client reads an answer to some of a turn's requests as `partial`; this was not observed.
