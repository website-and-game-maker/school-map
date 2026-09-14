// The feedback box. Gated behind the editor key, because what it produces is a
// work instruction against this repository and not a suggestion box entry.
//
// The panel shows the editor the prompt their words turned into, before they
// send it anywhere. That matters: the app wraps their sentence in a page of
// context, and somebody should be able to see exactly what is being said on
// their behalf rather than trusting a button labelled "submit".

import { useMemo, useState } from "react";
import {
  buildFeedbackPrompt,
  downloadPrompt,
  issueUrl,
  type FeedbackContext,
} from "../lib/feedback";

interface Props {
  context: FeedbackContext;
}

export default function FeedbackPanel({ context }: Props) {
  const [message, setMessage] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);

  const prompt = useMemo(
    () => (message.trim() ? buildFeedbackPrompt(message, context) : null),
    [message, context]
  );

  async function copy() {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard is blocked on insecure origins and in some embedded views;
      // the prompt is on screen either way, so this is not a dead end.
      setShowPrompt(true);
    }
  }

  return (
    <div className="feedback-panel">
      <p className="feedback-title">Report something wrong</p>
      <p className="hint">
        Say what's wrong in your own words — “220 takes me to the wrong room”, “the stairs by the
        library aren't marked”. It gets turned into a prompt you can hand straight to Claude Code,
        with the floor, the coordinates and the nearby points already filled in.
      </p>
      <textarea
        className="feedback-input"
        rows={4}
        value={message}
        placeholder="What's wrong, or what's missing?"
        onChange={(e) => setMessage(e.target.value)}
      />

      {prompt && (
        <>
          <div className="feedback-actions">
            <button className="save-btn" onClick={copy}>
              {copied ? "Copied ✓" : "Copy prompt"}
            </button>
            <a
              className="download-btn feedback-issue"
              href={issueUrl(prompt)}
              target="_blank"
              rel="noreferrer"
            >
              Open as issue
            </a>
            <button className="download-btn" onClick={() => downloadPrompt(prompt)}>
              Save .md
            </button>
          </div>
          <button className="feedback-peek" onClick={() => setShowPrompt((v) => !v)}>
            {showPrompt ? "Hide" : "Show"} the prompt this makes ({prompt.text.split("\n").length}{" "}
            lines)
          </button>
          {showPrompt && <pre className="feedback-preview">{prompt.text}</pre>}
        </>
      )}
    </div>
  );
}
