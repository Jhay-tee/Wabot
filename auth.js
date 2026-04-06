import { normalizeJid, isAdminStatic } from './utils.js';

const metadataCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getCachedMetadata(sock, groupJid) {
  const cached = metadataCache.get(groupJid);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const metadata = await sock.groupMetadata(groupJid);
    metadataCache.set(groupJid, { data: metadata, ts: Date.now() });
    return metadata;
  } catch (err) {
    console.error('groupMetadata fetch failed:', err.message);
    return null;
  }
}

export function invalidateGroupCache(groupJid) {
  if (groupJid) metadataCache.delete(groupJid);
  else metadataCache.clear();
}

export const isAdmin = async (sock, groupJid, userJid) => {
  const cleanJid = normalizeJid(userJid);

  if (isAdminStatic(cleanJid)) return true;

  if (!groupJid?.endsWith('@g.us')) return false;

  const metadata = await getCachedMetadata(sock, groupJid);
  if (!metadata) return false;

  const participant = metadata.participants.find(
    p => normalizeJid(p.id) === cleanJid
  );
  return ['admin', 'superadmin'].includes(participant?.admin);
};

export const isBotAdmin = async (sock, groupJid) => {
  if (!groupJid?.endsWith('@g.us')) return false;

  const metadata = await getCachedMetadata(sock, groupJid);
  if (!metadata) return false;

  const botJid = normalizeJid(sock.user?.id);
  const participant = metadata.participants.find(
    p => normalizeJid(p.id) === botJid
  );
  return ['admin', 'superadmin'].includes(participant?.admin);
};

export const getGroupMetadata = async (sock, groupJid) => {
  if (!groupJid?.endsWith('@g.us')) return null;
  return getCachedMetadata(sock, groupJid);
};
