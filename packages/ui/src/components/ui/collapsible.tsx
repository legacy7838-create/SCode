import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { cn } from "../lib/utils.js";

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      className={cn(
        "group/collapsible-content overflow-hidden",
        "data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up data-[state=closed]:[animation-fill-mode:forwards] transition-none duration-300 ease-in-out",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "transition-none duration-300 ease-in-out",
          "group-data-[state=open]/collapsible-content:animate-in group-data-[state=open]/collapsible-content:fade-in-0",
          "group-data-[state=closed]/collapsible-content:animate-out group-data-[state=closed]/collapsible-content:fade-out-0 group-data-[state=closed]/collapsible-content:[animation-fill-mode:forwards]",
        )}
      >
        {/* Large session resize trace shows collapsible animation layer only when setting duration/ease
            The browser will use the default transition-property: all animation scrollbar-color, and trigger non-synthetic animation when dragging the window.
            CSS transitions are explicitly disabled here, leaving only animate-in/out keyframe animations. */}
        {/* tw-animate-css does not have tool classes such as animate-fade-in / animate-fade-out.
            Must use animate-in/out with fade-in-0 / fade-out-0.
            At the same time, the sub-layer div itself does not have data-state, so here we continue to read the state of the parent layer content,
            Make transparency animation and height animation stable layering.
            Add a slight delay when opening to prevent the fade-in process from being consumed in advance when the content is still cropped at 0 height. */}
        {children}
      </div>
    </CollapsiblePrimitive.CollapsibleContent>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
