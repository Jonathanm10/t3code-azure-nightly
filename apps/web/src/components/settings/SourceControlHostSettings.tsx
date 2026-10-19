import { AzureDevOpsServerProfiles, type AzureDevOpsServerProfile } from "@t3tools/contracts";
import { azureDevOpsServerProfiles } from "@t3tools/shared/azureDevOps";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Input } from "../ui/input";
import { randomUUID } from "../../lib/utils";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SourceControlClientDefinition } from "@t3tools/client-runtime/source-control-clients";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

export function SourceControlHostSettings({
  environmentId,
  definition,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlClientDefinition & {
    readonly settings: NonNullable<SourceControlClientDefinition["settings"]>;
  };
  readonly onSaved: () => void;
}) {
  const saved = useEnvironmentSettings(
    environmentId,
    (settings) => settings.sourceControlHosts[definition.kind],
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `save ${definition.label} settings`,
  });
  const [saving, setSaving] = useState(false);
  const formDefinition = { settingsSchema: definition.settings };
  const hasSaved = Object.values(saved ?? {}).some((value) => value !== "");

  const save = async (fields: Record<string, unknown>) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { sourceControlHosts: { [definition.kind]: fields } } },
    });
    setSaving(false);
    if (result._tag === "Success") onSaved();
  };

  if (definition.kind === "azure-devops-server") {
    const profiles = azureDevOpsServerProfiles({
      sourceControlHosts: { [definition.kind]: saved ?? {} },
    });
    return (
      <fieldset disabled={saving} className="contents">
        <AzureDevOpsServerProfileEditor
          key={JSON.stringify(profiles)}
          saved={profiles}
          onSave={(profiles) => void save({ profiles })}
        />
        {profiles.length > 0 ? (
          <Button size="xs" variant="outline" onClick={() => void save({ profiles: [] })}>
            Remove
          </Button>
        ) : null}
      </fieldset>
    );
  }

  return (
    // Locked while saving, so an edit made mid-request is not overwritten by the saved value.
    <fieldset disabled={saving} className="contents">
      <ProviderSettingsForm
        definition={formDefinition}
        value={saved ?? {}}
        idPrefix={`source-control-${definition.kind}-${environmentId}`}
        variant="settings"
        onChange={(next) => {
          const fields = next ?? {};
          const changed = Object.fromEntries(
            Object.entries(fields).filter(([key, value]) => saved?.[key] !== value),
          );
          const cleared = Object.keys(saved ?? {}).filter((key) => !(key in fields));
          void save({ ...changed, ...Object.fromEntries(cleared.map((key) => [key, ""])) });
        }}
      />
      {hasSaved ? (
        <div className="flex justify-end pt-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void save(Object.fromEntries(Object.keys(saved ?? {}).map((key) => [key, ""])))
            }
          >
            Remove
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}

const decodeAzureProfiles = Schema.decodeUnknownOption(AzureDevOpsServerProfiles);
function AzureDevOpsServerProfileEditor({
  saved,
  onSave,
}: {
  readonly saved: ReadonlyArray<AzureDevOpsServerProfile>;
  readonly onSave: (profiles: ReadonlyArray<AzureDevOpsServerProfile>) => void;
}) {
  const [profiles, setProfiles] = useState(() =>
    saved.map((profile) => ({ ...profile, key: randomUUID() })),
  );
  const [error, setError] = useState<string | null>(null);
  const edit = (index: number, patch: Partial<AzureDevOpsServerProfile>) =>
    setProfiles((current) =>
      current.map((profile, position) => (position === index ? { ...profile, ...patch } : profile)),
    );
  const save = () => {
    const decoded = decodeAzureProfiles(
      profiles.map((profile) => ({
        apiCollectionUrl: profile.apiCollectionUrl.trim(),
        ...(profile.browserCollectionUrl?.trim()
          ? { browserCollectionUrl: profile.browserCollectionUrl.trim() }
          : {}),
      })),
    );
    if (Option.isNone(decoded)) {
      setError(
        "Use HTTPS collection URLs without credentials or query parameters. Collections and aliases must not overlap.",
      );
      return;
    }
    setError(null);
    onSave(decoded.value);
  };
  return (
    <>
      <div className="space-y-3 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Read and create pull requests using Git authentication on this environment. Add the
          collection URL used by your HTTPS clone URL and, if different, its browser collection URL.
        </p>
        {profiles.map((profile, index) => (
          <div key={profile.key} className="space-y-2 rounded-md border p-3">
            <label className="grid gap-1 text-sm">
              API collection URL
              <Input
                aria-label={`API collection URL ${index + 1}`}
                value={profile.apiCollectionUrl}
                placeholder="https://git.example.com/tfs/Collection"

                onChange={(event) => edit(index, { apiCollectionUrl: event.target.value })}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Browser collection URL (optional)
              <Input
                aria-label={`Browser collection URL ${index + 1}`}
                value={profile.browserCollectionUrl ?? ""}
                placeholder="https://web.example.com/tfs/Collection"

                onChange={(event) => edit(index, { browserCollectionUrl: event.target.value })}
              />
            </label>
            <Button
              variant="ghost"
              size="sm"

              onClick={() =>
                setProfiles((current) => current.filter((_, position) => position !== index))
              }
            >
              Remove collection
            </Button>
          </div>
        ))}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"

            onClick={() =>
              setProfiles((current) => [...current, { apiCollectionUrl: "", key: randomUUID() }])
            }
          >
            Add collection
          </Button>
          <Button size="sm" onClick={save}>
            Save collections
          </Button>
        </div>
      </div>
    </>
  );
}
