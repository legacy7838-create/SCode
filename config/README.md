# Built-in Default Configuration

`config/default.json` is the default configuration shipped with the client and must be retained. Desktop reads it from the packaged file;
Web imports it at build time; built-in values are used when remote requests fail or lack valid fields.

## Help Configuration Source

The new community and feedback entry points request `GET /api/v1/client/configs` from the current endpoint,
reading `data.configs.feedbackUrl`:

- `community_urls["zh-CN" | "en-US"]`: Only falls back to the built-in entry by current language, no cross-language fallback.
- `feedback_url`: Remote valid address takes priority; otherwise the built-in address is used.
- `feedback_use_external_form`: Remote boolean takes priority; `false` is also a valid override.

Requests carry `app_version`; Desktop additionally carries `platform-arch`, while Web omits the platform parameter.
Successful responses are memory-cached for 1 hour only; requests use `cache: no-store`; failures are not cached.

```text
Current endpoint client/configs -> valid help field -> platform entry
                   | missing / failed
                   v
          built-in default.json -> platform entry
```

default.json is the built-in default configuration distributed with the client; historically it was CDN-distributed and is retained only for old client compatibility.
The current version has no request or URL construction chain and only relies on the built-in file in this directory; other fields remain unchanged for existing consumers.

For detailed rules, see [User Community Entry Configuration](../docs/ui/settings-community-link-config.md).
