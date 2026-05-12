import { useState }       from "react";
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

      <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        <div className="section-heading">
          <span>
            My Bots{" "}
            <span className="badge badge-inactive" style={{ fontSize: "0.7rem" }}>
              {bots.length}/{maxBots}
            </span>
          </span>
          <button className="btn btn-primary btn-sm" onClick={() => setShowDeploy(true)}
            disabled={atLimit} title={atLimit ? "Upgrade to deploy more bots" : undefined}>
            + Deploy bot
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
          <div className="card">
            <EmptyState icon="🤖" title="No bots deployed yet"
              desc='Click "Deploy bot" to launch your first WhatsApp bot. Choose DM or Group mode.'
              action={<button className="btn btn-primary btn-sm" onClick={() => setShowDeploy(true)}>Deploy bot</button>}
            />
          </div>
        ) : (
          <div className="bots-grid">
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
