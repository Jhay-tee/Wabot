export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Mention all participants
export function createMentions(participants) {
    return participants.map(p => p.id);
}

// Check if sender is admin
export function isAdmin(sender, participants) {
    const user = participants.find(p => p.id === sender);
    return user?.admin || false;
}
