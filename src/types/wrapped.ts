export interface WrappedPostHighlight {
  _id: string;
  title: string | null;
  likes: number;
  uploadTimestamp: number;
}

export interface WrappedStats {
  year: number;
  generatedAt: number;
  thisYear: {
    coinsSpent: number;
    mcRealPostsCreated: number;
    mcRealCommentsWritten: number;
    topPosts: WrappedPostHighlight[];
  };
  lifetime: {
    highestLoginStreak: number;
    highestMcRealStreak: number;
    totalPostOfTheDays: number;
    cosmeticsOwned: number;
    memberSince: number;
  };
}

export interface CommunityWrappedStats {
  year: number;
  generatedAt: number;
  newPlayers: number;
  coinsSpent: number;
  supporters: number;
  mcRealPosts: number;
  mcRealComments: number;
  mcRealLikes: number;
  referralDownloads: number;
  capesReviewed: number;
  capesAccepted: number;
}

export interface WrappedLocalStats {
  playtimeSeconds: number;
  favoriteProfile: { name: string; playtimeSeconds: number; version: string } | null;
}
