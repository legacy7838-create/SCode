import { cn } from "@/components/lib/utils.js";
import zaiLogoUrl from "@/assets/provider-icons/logo-zai.svg";

export function WindowsTopLeftLogo({
  className,
  imageClassName,
}: {
  className?: string;
  imageClassName?: string;
}) {
  return (
    <div
      className={cn(
        // The left tool group of the Workspace starts from 1px behind the panel border, but the old title layer of Settings starts from the 0 point of the window.
        // The Workspace logo is located within the 28px button, and there is 4px of white space in the middle of the image relative to the left edge of the button;
        // Settings directly renders the 20px image, and cannot use the left 13px of the button container as the image coordinates.
        // After accounting for the 4px outer whitespace, 1px border, and 4px inside the button, both images are left 17px / top 19px.
        "absolute left-1 top-1 mt-px ml-px z-20 flex h-12 items-center px-3 [app-region:drag]",
        className,
      )}
    >
      <img
        src={zaiLogoUrl}
        alt="ZCode"
        className={cn("pointer-events-none size-5 select-none", imageClassName)}
        draggable={false}
      />
    </div>
  );
}
