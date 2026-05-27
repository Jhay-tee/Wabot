import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, Plus } from "lucide-react";
import { BotCard }        from "../../components/bots/BotCard.jsx";
import { DeployModal }    from "../../components/bots/DeployModal.jsx";
import { BotConfigModal } from "../../components/bots/BotConfigModal.jsx";
import { SendDMModal }    from "../../components/bots/SendDMModal.jsx";
import { Alert }          from "../../components/ui/Alert.jsx";
import { EmptyState }     from "../../components/ui/EmptyState.jsx";
import { botsApi }        from "../../api/bots.js";

function setModalHash(nextHash) {
  const normalized = nextHash ? `#${nextHash}` : "";
  if (window.location.hash === normalized) return;
  const nextUrl = `${window.location.pathname}${window.location.search}${normalized}`;
  window.history.pushState(null, "", nextUrl);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function parseModalHash(hashValue) {
  const hash = hashValue.replace(/^#/, "");
  if (!hash) return { type: null, botId: null };
  if (hash === "deploy") return { type: "deploy", botId: null };

  const [type, ...rest] = hash.split(":");
  const botId = rest.join(":") || null;

  if (type === "config" || type === "qr" || type === "dm") {
    return { type, botId };
  }

  return { type: null, botId: null };
}

export function Bots({ data, onRefresh }) {
  const navigate = useNavigate();
  const { user, bots, stats } = data;
  const [showDeploy, setShowDeploy] = useState(false);
  const [configBot,  setConfigBot]  = useState(null);
  const [dmBot,      setDmBot]      = useState(null);
  const [deleting,   setDeleting]   = useState(null);
  const [deleteErr,  setDeleteErr]  = useState("");
  const [deployNotice, setDeployNotice] = useState(null);

  const isPro   = user?.plan_tier === "paid";
  const maxBots = stats?.planLimit ?? (isPro ? 50 : 1);
  const atLimit = bots.length >= maxBots;

  useEffect(() => {
    const syncModalFromHash = () => {
      const { type, botId } = parseModalHash(window.location.hash);
      const targetBot = botId ? bots.find((item) => item.id === botId) ?? null : null;

      setShowDeploy(type === "deploy");
      setConfigBot(
        type === "config" && targetBot ? targetBot
          : type === "qr" && targetBot ? { ...targetBot, _openQr: true }
          : null
      );
      setDmBot(type === "dm" && targetBot ? targetBot : null);
    };

    syncModalFromHash();
    window.addEventListener("hashchange", syncModalFromHash);
    return () => window.removeEventListener("hashchange", syncModalFromHash);
  }, [bots]);

  const closeModal = () => setModalHash("");

  const openDeploy = () => setModalHash("deploy");
  const openConfig = (bot, openQr = false) => {
    if (!bot?.id) return;
    setModalHash(`${openQr ? "qr" : "config"}:${bot.id}`);
  };
  const openDm = (bot) => {
    if (!bot?.id) return;
    setModalHash(`dm:${bot.id}`);
  };

  const handleDeployed = async (payload) => {
    closeModal();
    await onRefresh();
    if (!payload?.bot) return;
    setDeployNotice({
      bot: payload.bot,
      preferredAuthMethod: payload.preferredAuthMethod ?? "qr",
      preferredPairPhone: payload.preferredPairPhone ?? null,
    });
  };

  const handleDelete = async (bot) => {
    if (!window.confirm(`Delete "${bot.bot_name}"? This disconnects it from WhatsApp and cannot be undone.`)) return;
    setDeleteErr("");
    setDeleting(bot.id);
    try { await botsApi.remove(bot.id); onRefresh(); }
    catch (err) { setDeleteErr(err.message); }
    finally { setDeleting(null); }
  };

  const handleShowQr = (bot) => openConfig(bot, true);

  return (
    <>
      {showDeploy && (
        <DeployModal user={user} onClose={closeModal} onDeployed={handleDeployed} />
      )}
      {configBot && (
        <BotConfigModal
          bot={configBot}
          user={user}
          onClose={() => { closeModal(); onRefresh(); }}
          onSaved={(updated) => {
            setConfigBot((b) => (b ? { ...b, ...updated } : b));
            onRefresh();
          }}
        />
      )}
      {dmBot && <SendDMModal bot={dmBot} onClose={closeModal} />}

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
            onClick={openDeploy}
            disabled={atLimit}
            title={atLimit ? "Upgrade to deploy more bots" : undefined}
          >
            <Plus size={16} />
            Deploy bot
          </button>
        </div>

        {deleteErr && <Alert type="error">{deleteErr}</Alert>}

        {deployNotice && (
          <Alert type="success">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <strong>{deployNotice.bot.bot_name}</strong> was deployed successfully.
                <div className="mt-1 text-xs text-current/80">
                  The new bot card is now visible below. Open its auth panel when you’re ready to continue with {deployNotice.preferredAuthMethod === "code" ? "pairing code" : "QR"} setup.
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  className="inline-flex items-center justify-center rounded-2xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/20"
                  onClick={() => {
                    setDeployNotice(null);
                    setConfigBot({
                      ...deployNotice.bot,
                      _openQr: true,
                      _preferredAuthMethod: deployNotice.preferredAuthMethod,
                      _autoRequestPairPhone: deployNotice.preferredPairPhone,
                    });
                  }}
                >
                  Open auth panel
                </button>
                <button
                  className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-[var(--text)] transition hover:bg-white/10"
                  onClick={() => setDeployNotice(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          </Alert>
        )}

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
              action={<button className="inline-flex items-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90" onClick={openDeploy}><Bot size={16} /> Deploy bot</button>}
            />
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
            {bots.map((bot) => (
              <BotCard key={bot.id} bot={bot}
                onOpenPage={(targetBot) => navigate(`/dashboard/bots/${targetBot.id}`)}
                onConfigure={openConfig}
                onShowQr={handleShowQr}
                onSendDM={openDm}
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
