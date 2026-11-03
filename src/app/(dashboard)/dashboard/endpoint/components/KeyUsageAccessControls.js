"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Toggle } from "@/shared/components";

export default function KeyUsageAccessControls({ apiKey, onChange }) {
  const allowKeyUsage = apiKey.allowKeyUsage !== false;
  const allowModelList = apiKey.allowKeyUsageModelList !== false;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const update = async (patch) => {
    setSaving(true);
    setError("");
    const result = await onChange(patch);
    setSaving(false);
    if (!result?.ok) setError(result?.error || "Failed to update Key Usage access");
  };

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-2/40 p-2.5" data-testid="key-usage-access">
      <Toggle
        size="sm"
        checked={allowKeyUsage}
        disabled={saving}
        label="Allow viewing Key Usage"
        description="Let this key view its usage totals, quotas, and preferences"
        onChange={(checked) => update({ allowKeyUsage: checked })}
      />
      <div className="ml-4 mt-2 border-l border-border pl-3">
        <Toggle
          size="sm"
          checked={allowModelList}
          disabled={saving || !allowKeyUsage}
          label="Allow viewing model list"
          description="Show allowed models and per-model activity for this key"
          onChange={(checked) => update({ allowKeyUsageModelList: checked })}
        />
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}

KeyUsageAccessControls.propTypes = {
  apiKey: PropTypes.shape({
    allowKeyUsage: PropTypes.bool,
    allowKeyUsageModelList: PropTypes.bool,
  }).isRequired,
  onChange: PropTypes.func.isRequired,
};
