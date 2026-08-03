import { createSignal, Show } from "solid-js";

interface ImagePaneProps {
  filePath: string;
}

// Read-only viewer for an image file opened directly from the file tree (as
// opposed to one embedded in a markdown note — see MarkdownPane/lib/markdown.ts
// for that path). The renderer's document is file:// already, so an absolute
// path just works as an <img src> with no read/IPC step needed.
export default function ImagePane(props: ImagePaneProps) {
  const [failed, setFailed] = createSignal(false);
  const [naturalSize, setNaturalSize] = createSignal<string | null>(null);

  return (
    <div class="image-pane">
      <div class="image-toolbar">
        <span class="image-filepath">{props.filePath}</span>
        <Show when={naturalSize()}>
          <span class="image-dimensions">{naturalSize()}</span>
        </Show>
      </div>
      <div class="image-body">
        <Show
          when={!failed()}
          fallback={<div class="image-error">Can't load this image.</div>}
        >
          <img
            src={props.filePath}
            alt={props.filePath}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize(`${img.naturalWidth} × ${img.naturalHeight}`);
            }}
            onError={() => setFailed(true)}
          />
        </Show>
      </div>
    </div>
  );
}
