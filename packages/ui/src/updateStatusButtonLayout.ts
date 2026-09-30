export function resolveUpdateButtonResponsiveClasses({
  isMacDesktop,
  isWindowsDesktop,
}: {
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
}) {
  // Tailwind can only collect complete class names that appear in the source code.
  // After spelling the container query prefix as `${responsiveExpandClass}:...`,
  // The `@min-[200px]/topoverlayer:*` corresponding to the Windows branch will not enter the final CSS at all.
  // The manifestation is that the platform's judgment "doesn't seem to be effective".
  if (isMacDesktop) {
    return {
      expandWidthClass: "@min-[280px]/topoverlayer:w-auto",
      hideIconClass: "@min-[280px]/topoverlayer:hidden",
      revealTextClass: [
        "@min-[280px]/topoverlayer:opacity-100",
        "@min-[280px]/topoverlayer:w-auto",
        "@min-[280px]/topoverlayer:relative",
      ],
    };
  }

  if (isWindowsDesktop) {
    return {
      expandWidthClass: "@min-[216px]/topoverlayer:w-auto",
      hideIconClass: "@min-[216px]/topoverlayer:hidden",
      revealTextClass: [
        "@min-[216px]/topoverlayer:opacity-100",
        "@min-[216px]/topoverlayer:w-auto",
        "@min-[216px]/topoverlayer:relative",
      ],
    };
  }

  return {
    expandWidthClass: "@min-[280px]/topoverlayer:w-auto",
    hideIconClass: "@min-[280px]/topoverlayer:hidden",
    revealTextClass: [
      "@min-[280px]/topoverlayer:opacity-100",
      "@min-[280px]/topoverlayer:w-auto",
      "@min-[280px]/topoverlayer:relative",
    ],
  };
}
