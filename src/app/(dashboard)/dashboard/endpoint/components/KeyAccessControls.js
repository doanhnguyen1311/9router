"use client";

// Per-API-key access control on the Endpoint page.
// Model and provider-account restrictions are independent. Model entries use
// the shared picker; account ids come from the safe /api/providers response.
import { useState } from "react";
import PropTypes from "prop-types";
import { Toggle, ModelSelectModal } from "@/shared/components";

export default function KeyAccessControls({ apiKey, onChange, onRequestRestrict }) {
  const access = apiKey.access || {
    restricted: false,
    allow: [],
    accountRestricted: false,
    accountIds: [],
  };
  const [pickerOpen, setPickerOpen] = useState(false);
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [accountDraft, setAccountDraft] = useState([]);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState("");
  const accountIds = access.accountIds || [];

  const accessValue = (patch = {}) => ({
    restricted: access.restricted === true,
    allow: access.allow || [],
    accountRestricted: access.accountRestricted === true,
    accountIds: access.accountIds || [],
    ...patch,
  });

  const loadAccounts = async () => {
    if (activeProviders.length > 0) return activeProviders;
    setAccountsLoading(true);
    setAccountsError("");
    try {
      const response = await fetch("/api/providers");
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const connections = (await response.json()).connections || [];
      setActiveProviders(connections);
      return connections;
    } catch (error) {
      setAccountsError(error.message || "Failed to load provider accounts");
      return [];
    } finally {
      setAccountsLoading(false);
    }
  };

  const openPicker = async () => {
    setPickerOpen(true);
    // Same sources the combo editor feeds the picker with.
    try {
      const [providersRes, aliasRes] = await Promise.all([fetch("/api/providers"), fetch("/api/models/alias")]);
      if (providersRes.ok) setActiveProviders((await providersRes.json()).connections || []);
      if (aliasRes.ok) setModelAliases((await aliasRes.json()).aliases || {});
    } catch (error) {
      console.log("Error loading picker data:", error);
    }
  };

  const setAllow = (allow) => onChange(accessValue({ restricted: true, allow }));
  const add = (model) => {
    const value = model?.value;
    if (value && !access.allow.some((e) => e.toLowerCase() === value.toLowerCase())) setAllow([...access.allow, value]);
  };
  const remove = (value) => setAllow(access.allow.filter((e) => e !== value));
  const setAccountIds = (accountIds) => onChange(accessValue({ accountRestricted: true, accountIds }));
  const toggleDraftAccount = (id) => setAccountDraft((current) => (
    current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id]
  ));
  const accountById = new Map(activeProviders.map((connection) => [connection.id, connection]));
  const accountLabel = (id) => {
    const connection = accountById.get(id);
    if (!connection) return id.length > 16 ? `${id.slice(0, 12)}…` : id;
    return connection.displayName || connection.name || connection.email || connection.id;
  };
  const groupedAccounts = activeProviders.reduce((groups, connection) => {
    const provider = connection.provider || "unknown";
    if (!groups[provider]) groups[provider] = [];
    groups[provider].push(connection);
    return groups;
  }, {});

  return (
    <div className="mt-2" data-testid="key-access">
      <Toggle
        size="sm"
        checked={access.restricted}
        label="Restrict models"
        onChange={(checked) => (checked
          ? onRequestRestrict()
          : onChange(accessValue({ restricted: false, allow: [] })))}
      />
      {access.restricted && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {access.allow.length === 0 && (
            <span className="text-xs text-orange-500">No combos or models allowed — this key can call nothing.</span>
          )}
          {access.allow.map((entry) => (
            <span key={entry} className="flex items-center gap-1 rounded-xl border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-xs text-text-main">
              {entry}
              <button
                type="button"
                onClick={() => remove(entry)}
                className="rounded text-text-muted hover:text-red-500"
                title={`Remove ${entry}`}
                aria-label={`Remove ${entry}`}
              >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: "12px" }}>close</span>
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={openPicker}
            className="flex items-center gap-0.5 rounded-xl border border-dashed border-black/10 px-2 py-0.5 text-xs font-medium text-primary hover:border-primary/50 dark:border-white/10"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: "14px" }}>add</span>
            Add combo or model
          </button>
        </div>
      )}
      <div className="mt-2">
        <Toggle
          size="sm"
          checked={access.accountRestricted === true}
          label="Restrict provider accounts"
          onChange={async (checked) => {
            if (checked) {
              await loadAccounts();
              setAccountDraft(accountIds);
              setAccountPickerOpen(true);
              onChange(accessValue({ accountRestricted: true }));
            } else {
              setAccountPickerOpen(false);
              onChange(accessValue({ accountRestricted: false, accountIds: [] }));
            }
          }}
        />
      </div>
      {access.accountRestricted && (
        <div className="mt-2 rounded-lg border border-border bg-surface-2/40 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {accountIds.length === 0 && (
              <span className="text-xs text-orange-500">No accounts allowed — credentialed providers cannot be called.</span>
            )}
            {accountIds.map((id) => (
              <span key={id} className="flex items-center gap-1 rounded-xl border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-text-main">
                {accountLabel(id)}
                <button
                  type="button"
                  onClick={() => setAccountIds(accountIds.filter((entry) => entry !== id))}
                  className="rounded text-text-muted hover:text-red-500"
                  title={`Remove ${accountLabel(id)}`}
                  aria-label={`Remove ${accountLabel(id)}`}
                >
                  <span className="material-symbols-outlined leading-none" style={{ fontSize: "12px" }}>close</span>
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={async () => {
                await loadAccounts();
                if (!accountPickerOpen) setAccountDraft(accountIds);
                setAccountPickerOpen((open) => !open);
              }}
              className="flex items-center gap-0.5 rounded-xl border border-dashed border-black/10 px-2 py-0.5 text-xs font-medium text-primary hover:border-primary/50 dark:border-white/10"
            >
              <span className="material-symbols-outlined leading-none" style={{ fontSize: "14px" }}>manage_accounts</span>
              {accountPickerOpen ? "Close accounts" : "Choose accounts"}
            </button>
          </div>

          {accountPickerOpen && (
            <div className="mt-2 max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border bg-surface-1 p-2">
              {accountsLoading && <p className="text-xs text-text-muted">Loading accounts...</p>}
              {accountsError && <p className="text-xs text-red-500">{accountsError}</p>}
              {!accountsLoading && !accountsError && activeProviders.length === 0 && (
                <p className="text-xs text-text-muted">No provider accounts are configured.</p>
              )}
              {Object.entries(groupedAccounts).map(([provider, connections]) => (
                <div key={provider}>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{provider}</p>
                  <div className="space-y-1">
                    {connections.map((connection) => (
                      <label key={connection.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/5">
                        <input
                          type="checkbox"
                          checked={accountDraft.includes(connection.id)}
                          onChange={() => toggleDraftAccount(connection.id)}
                          className="h-3.5 w-3.5 accent-primary"
                        />
                        <span className="min-w-0 flex-1 truncate">{accountLabel(connection.id)}</span>
                        {connection.isActive === false && <span className="text-orange-500">Paused</span>}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              {!accountsLoading && !accountsError && activeProviders.length > 0 && (
                <div className="flex justify-end gap-2 border-t border-border pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setAccountDraft(accountIds);
                      setAccountPickerOpen(false);
                    }}
                    className="rounded px-2 py-1 text-xs text-text-muted hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAccountIds(accountDraft);
                      setAccountPickerOpen(false);
                    }}
                    className="rounded bg-primary px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
                  >
                    Save accounts
                  </button>
                </div>
              )}
            </div>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
            Routing and fallback stay inside this account list. Public no-auth providers are unaffected.
          </p>
        </div>
      )}
      {pickerOpen && (
        <ModelSelectModal
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={add}
          onDeselect={(model) => remove(access.allow.find((e) => e.toLowerCase() === String(model?.value).toLowerCase()))}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title={`Allowed for "${apiKey.name}"`}
          addedModelValues={access.allow}
          closeOnSelect={false}
        />
      )}
    </div>
  );
}

KeyAccessControls.propTypes = {
  apiKey: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    access: PropTypes.shape({
      restricted: PropTypes.bool,
      allow: PropTypes.arrayOf(PropTypes.string),
      accountRestricted: PropTypes.bool,
      accountIds: PropTypes.arrayOf(PropTypes.string),
    }),
  }).isRequired,
  onChange: PropTypes.func.isRequired,
  onRequestRestrict: PropTypes.func.isRequired,
};
