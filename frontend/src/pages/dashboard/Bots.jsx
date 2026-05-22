import { useState }       from "react";
import { Bot, Plus } from "lucide-react";
import { BotCard }        from "../../components/bots/BotCard.jsx";
import { DeployModal }    from "../../components/bots/DeployModal.jsx";
import { BotConfigModal } from "../../components/bots/BotConfigModal.jsx";
import { SendDMModal }    from "../../components/bots/SendDMModal.jsx";
import { Alert }          from "../../components/ui/Alert.jsx";
import { EmptyState }     from "../../components/ui/EmptyState.jsx";
import { botsApi }        from "../../api/bots.js";

export function Bots({ data, onRefresh }) {
  const { user, bots, stats } = data;
  const [showDeploy, setShowDeploy] = useState(false);
  const [configBot,  setConfigBot]  = useState(null);
  const [dmBot,      setDmBot]      = useState(null);
  const [deleting,   setDeleting]   = useState(null);
  const [deleteErr,  setDeleteErr]  = useState("");

  const isPro   = user?.plan_tier === "paid";
  const maxBots = stats?.planLimit ?? (isPro ? 50 : 1);
  const atLimit = bots.length >= maxBots;

  const handleDeployed = () => { setShowDeploy(false); onRefresh(); };

  const handleDelete = async (bot) => {
    if (!window.confirm(`Delete "${bot.bot_name}"? This disconnects it from WhatsApp and cannot be undone.`)) return;
    setDeleteErr("");
    setDeleting(bot.id);
    try { await botsApi.remove(bot.id); onRefresh(); }
    catch (err) { setDeleteErr(err.message); }
    finally { setDeleting(null); }
  };

  const handleShowQr = (bot) => setConfigBot({ ...bot, _openQr: true });

  return (
    <>
      {showDeploy && (
        <DeployModal user={user} onClose={() => setShowDeploy(false)} onDeployed={handleDeployed} />
      )}
      {configBot && (
        <BotConfigModal
          bot={configBot}
          user={user}
          onClose={() => { setConfigBot(null); onRefresh(); }}
          onSaved={(updated) => setConfigBot((b) => ({ ...b, ...updated }))}
        />
      )}
      {dmBot && <SendDMModal bot={dmBot} onClose={() => setDmBot(null)} />}

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 rounded-[28px] border border-white/10 bg-[var(--card)] p-5 shadow-lg md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text3)]">Bots</div>
            <div className="mt-1 flex items-center gap-3">
              <h2 className="text-2xl font-semibold">My Bots</h2>
              <span className="inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-[var(--text2)]">
                {bots.length}/{maxBots}
              </span>
            </div>
            <p className="mt-2 text-sm text-[var(--text2)]">Manage pairing, automation rules, and outbound messaging for each WhatsApp session.</p>
          </div>
          <button
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => setShowDeploy(true)}
            disabled={atLimit}
            title={atLimit ? "Upgrade to deploy more bots" : undefined}
          >
            <Plus size={16} />
            Deploy bot
          </button>
        </div>

        {deleteErr && <Alert type="error">{deleteErr}</Alert>}

        {atLimit && !isPro && (
          <Alert type="info">
            You've reached the Free plan limit of {maxBots} bot.{" "}
            <strong style={{ color: "var(--accent)" }}>Upgrade to Pro</strong> for up to 50 bots.
          </Alert>
        )}

        {bots.length === 0 ? (
          <div className="rounded-[28px] border border-white/10 bg-[var(--card)] p-6 shadow-lg">
            <EmptyState icon={<Bot size={28} />} title="No bots deployed yet"
              desc='Click "Deploy bot" to launch your first WhatsApp bot. Choose DM or Group mode.'
              action={<button className="inline-flex items-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90" onClick={() => setShowDeploy(true)}><Bot size={16} /> Deploy bot</button>}
            />
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
            {bots.map((bot) => (
              <BotCard key={bot.id} bot={bot}
                onConfigure={setConfigBot}
                onShowQr={handleShowQr}
                onSendDM={setDmBot}
                onDelete={handleDelete}
                deleting={deleting}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
