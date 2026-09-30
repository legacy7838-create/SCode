import { useState } from "react";
import { GlobeIcon } from "lucide-react";

function BrowserTabFaviconImage({ faviconUrl }: { faviconUrl: string }) {
  const [hasFailed, setHasFailed] = useState(false);

  if (hasFailed) return <GlobeIcon className="size-3.5" />;

  return (
    <img
      src={faviconUrl}
      alt=""
      className="size-3.5 rounded-sm object-contain"
      draggable={false}
      // When the renderer directly loads the guest favicon, it will carry the localhost Referer.
      // A CDN with anti-hotlinking will return 403; disabling the referrer will be consistent with the successful request of the web page guest itself.
      referrerPolicy="no-referrer"
      onError={() => setHasFailed(true)}
    />
  );
}

/**
 * The favicon shared by Browser and Browser Use; it keeps a stable globe placeholder when the
 * request fails.
 */
export function BrowserTabFavicon({ faviconUrl }: { faviconUrl?: string | null }) {
  if (!faviconUrl) return <GlobeIcon className="size-3.5" />;

  return <BrowserTabFaviconImage key={faviconUrl} faviconUrl={faviconUrl} />;
}
