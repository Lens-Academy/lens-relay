export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export interface DiscordMessage {
  id: string;
  content: string;
  author: DiscordUser;
  timestamp: string;
  type: number;
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

export function useMessages(_channelId: string | null) {
  return {
    messages: [] as DiscordMessage[],
    channelName: null as string | null,
    loading: false,
    error: null as string | null,
    refetch: () => {},
  };
}
