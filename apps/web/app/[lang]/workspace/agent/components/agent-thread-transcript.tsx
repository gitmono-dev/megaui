import type { AgentMessage } from "@megaui/core";
import {
  Conversation,
  Loader,
  Message,
  MessageCitations,
  MessageContent,
} from "@megaui/ui/ai-elements";

import { agentMessagePlainText } from "../lib/message-text";

interface AgentThreadTranscriptProps {
  readonly citationsLabel: string;
  readonly messages: readonly AgentMessage[];
  readonly streamingText: string | null;
}

export function AgentThreadTranscript({
  citationsLabel,
  messages,
  streamingText,
}: AgentThreadTranscriptProps) {
  return (
    <Conversation
      data-mega-agent="conversation"
      style={{ flex: 1, minHeight: 240, overflow: "auto" }}
    >
      {messages.map((message) => (
        <Message from={message.role === "assistant" ? "assistant" : "user"} key={message.id}>
          <MessageContent>{agentMessagePlainText(message)}</MessageContent>
          {message.role === "assistant" ? (
            <MessageCitations citations={message.citations} label={citationsLabel} />
          ) : null}
        </Message>
      ))}
      {streamingText !== null ? (
        <Message data-streaming="true" from="assistant">
          <MessageContent>{streamingText || <Loader />}</MessageContent>
        </Message>
      ) : null}
    </Conversation>
  );
}
