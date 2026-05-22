export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function createMentions(participants) {
    return participants.map(p => p.id);
}

export function isAdmin(sender, participants) {
    const user = participants.find(p => p.id === sender);
    return user?.admin || false;
}
