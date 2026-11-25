# Rallumi v0.2.0

This macOS preview makes group conversations easier to start, follow, and stop inside Codex.

- **Quote a message.** Click the reply arrow to quote it. Quoting an agent replies to that agent by default. Use @ to choose a different recipient or address everyone.
- **End a discussion and move on.** End the current discussion to clear queued work, interrupt active replies, and return to the composer.
- **Send messages with immediate feedback.** A pending bubble appears while the message is being sent. Failed sends keep the draft. Agent avatars show a moving outline while they work.
- **Type and find people more easily.** Pinyin composition takes priority over send shortcuts and mention suggestions. Typing after @ filters members, including with a full-width ＠.
- **Send less group history.** Rallumi avoids repeating the current prompt in the extra group context and prioritizes recent, relevant messages. This uses local rules.
- **Start with a clearer guide.** The in-app guide can insert an editable example, explains who receives a message, and shows how to connect an existing Codex conversation.
- **Run the service when needed.** The Codex plugin starts the local service when it connects. The service it starts exits with the plugin. Upgrading removes the login item used by the previous preview.

## Install or upgrade

Download and unzip **Rallumi-Preview-macOS.zip**, then run **Install Rallumi.command**. Quit and reopen Codex if it was open during the upgrade. Select **Rallumi** in the Codex sidebar.

The installer reuses your existing local Rallumi data. New installations start with a sample group on the user's Mac. English is the default, with Simplified Chinese available from the sidebar.

Rallumi is available under the [PolyForm Noncommercial License 1.0.0](https://github.com/wwa821/rallumi/blob/main/LICENSE).
