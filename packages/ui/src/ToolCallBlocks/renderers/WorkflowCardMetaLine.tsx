import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * One line of metadata at the top of a tool card's body: a muted label + a monospace value (source
 * file name, run id, …), optionally followed by a muted note. `marker` becomes
 * `data-workflow-card-<marker>="true"`, which tests and styles use to find the row; `flag` becomes
 * `data-workflow-card-<marker>-<flag>="true"`, stating an additional fact that holds for this row.
 */
export function WorkflowCardMetaLine({
  marker,
  label,
  value,
  title,
  note,
  flag,
}: {
  marker: string;
  label: string;
  value: string;
  title?: string;
  note?: string;
  flag?: string;
}) {
  return (
    <p
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-ui-sm"
      {...{ [`data-workflow-card-${marker}`]: "true" }}
      {...(flag === undefined ? {} : { [`data-workflow-card-${marker}-${flag}`]: "true" })}
    >
      <span className="shrink-0 text-foreground-subtlest">{label}</span>
      <span className="min-w-0 truncate font-mono text-foreground-subtle" title={title ?? value}>
        {value}
      </span>
      {note === undefined ? null : (
        <span className="shrink-0 text-foreground-subtlest">· {note}</span>
      )}
    </p>
  );
}

/**
 * lineage in the body of an amend row: "Amends run X" — which run this card is amending. `runId` is
 * read from the AmendWorkflow input arguments (`run_id`), by the same read rule as the confirmation
 * dialog; a CreateWorkflow row has no such field, so the body has no such line either.
 *
 * `scriptInherited`: this amendment omitted the script and reuses the predecessor's one ("Keeping
 * the predecessor's script"), adding "script unchanged" at the end of the line — there is no script
 * on the card to collapse, and the missing script is exactly the point of this call.
 */
export function WorkflowAmendsLine({
  runId,
  scriptInherited = false,
}: {
  runId: string;
  scriptInherited?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <WorkflowCardMetaLine
      marker="amends"
      label={intl.formatMessage({ id: "chat.toolCall.workflow.amend.amends" })}
      value={runId}
      {...(scriptInherited
        ? {
            note: intl.formatMessage({ id: "chat.toolCall.workflow.amend.scriptUnchanged" }),
            flag: "script-inherited",
          }
        : {})}
    />
  );
}
