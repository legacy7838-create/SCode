interface SuccessfulPluginEnabledChangeOptions {
  submit: () => Promise<boolean>;
  isCurrent: () => boolean;
  onSuccess: () => void | Promise<void>;
}

/**
 * Only once the current plugin enable/disable has been confirmed successful by the server may the
 * authorization flow or the runtime refresh proceed.
 *
 * The old flow opened the authorization dialog before the enable-CUA RPC completed; when the RPC
 * failed or its response arrived late after a page switch, the user still saw a stale dialog
 * offering to continue authorizing, producing a split state where “the plugin is not enabled but is
 * already authorized”.
 */
export async function runAfterSuccessfulPluginEnabledChange({
  submit,
  isCurrent,
  onSuccess,
}: SuccessfulPluginEnabledChangeOptions): Promise<boolean> {
  const succeeded = await submit();
  if (!succeeded || !isCurrent()) {
    return false;
  }

  await onSuccess();
  return true;
}
