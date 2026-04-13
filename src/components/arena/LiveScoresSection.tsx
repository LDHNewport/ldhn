import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeMatches } from "@/hooks/useRealtimeMatches";
import LiveIndicator from "./LiveIndicator";
import SectionTitle from "./SectionTitle";

interface TeamData {
  id: string;
  name: string;
  abbr: string;
  color: string;
  logo_url?: string | null;
}

interface MatchData {
  id: string;
  home_score: number;
  away_score: number;
  status: string;
  period: string | null;
  match_date: string;
  is_live: boolean;
  home_locker_room: string | null;
  away_locker_room: string | null;
  home_team: TeamData;
  away_team: TeamData;
}

const ScoreCard = ({ match, isLive }: { match: MatchData; isLive: boolean }) => (
  <motion.div
    className="relative bg-arena-surface border border-border rounded-2xl p-6 glow-neon"
    initial={{ opacity: 0, scale: 0.9 }}
    animate={{ opacity: 1, scale: 1 }}
    transition={{ duration: 0.4 }}
  >
    {isLive && (
      <div className="absolute top-4 right-4">
        <LiveIndicator />
      </div>
    )}
    {isLive && match.period && (
      <div className="absolute top-4 left-4 text-muted-foreground font-display text-sm tracking-wider">
        {match.period}
      </div>
    )}
    {!isLive && (
      <div className="absolute top-4 left-4 text-muted-foreground font-display text-sm tracking-wider">
        {new Date(match.match_date).toLocaleDateString("fr-CA", { day: "numeric", month: "short" })} · FINAL
      </div>
    )}
    <div className="flex items-center justify-center gap-8 mt-8">
      <div className="flex flex-col items-center gap-3">
        <motion.div
          className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-display font-bold border-2"
          style={{ borderColor: match.home_team.color, color: match.home_team.color }}
          animate={isLive ? { boxShadow: [`0 0 10px ${match.home_team.color}40`, `0 0 25px ${match.home_team.color}60`, `0 0 10px ${match.home_team.color}40`] } : {}}
          transition={{ duration: 2, repeat: Infinity }}
        >
          {match.home_team.logo_url ? (
            <img src={match.home_team.logo_url} alt={`Logo ${match.home_team.name}`} className="w-full h-full rounded-full object-cover" />
          ) : (
            match.home_team.abbr
          )}
        </motion.div>
        <span className="text-sm text-muted-foreground font-display tracking-wider">{match.home_team.name}</span>
      </div>
      <div className="flex items-center gap-4">
        <span className="font-display text-7xl font-bold text-foreground">{match.home_score}</span>
        <span className="font-display text-3xl text-muted-foreground">-</span>
        <span className="font-display text-7xl font-bold text-foreground">{match.away_score}</span>
      </div>
      <div className="flex flex-col items-center gap-3">
        <motion.div
          className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-display font-bold border-2"
          style={{ borderColor: match.away_team.color, color: match.away_team.color }}
          animate={isLive ? { boxShadow: [`0 0 10px ${match.away_team.color}40`, `0 0 25px ${match.away_team.color}60`, `0 0 10px ${match.away_team.color}40`] } : {}}
          transition={{ duration: 2, repeat: Infinity }}
        >
          {match.away_team.logo_url ? (
            <img src={match.away_team.logo_url} alt={`Logo ${match.away_team.name}`} className="w-full h-full rounded-full object-cover" />
          ) : (
            match.away_team.abbr
          )}
        </motion.div>
        <span className="text-sm text-muted-foreground font-display tracking-wider">{match.away_team.name}</span>
      </div>
    </div>
    {(match.home_locker_room || match.away_locker_room) && (
      <div className="mt-6 border border-primary/30 rounded-xl bg-secondary/40 p-3">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-bold mb-2">Chambres</p>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-md bg-background/50 border border-border px-2 py-1.5 text-center">
            <span className="font-display font-bold">{match.home_team.abbr}</span> · {match.home_locker_room || "N/D"}
          </div>
          <div className="rounded-md bg-background/50 border border-border px-2 py-1.5 text-center">
            <span className="font-display font-bold">{match.away_team.abbr}</span> · {match.away_locker_room || "N/D"}
          </div>
        </div>
      </div>
    )}
  </motion.div>
);

const LiveScoresSection = () => {
  useRealtimeMatches();
  const previewRooms =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("preview_rooms") === "1";

  const { data: matches } = useQuery({
    queryKey: ["matches"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matches")
        .select("*, home_team:teams!matches_home_team_id_fkey(*), away_team:teams!matches_away_team_id_fkey(*)")
        .order("match_date", { ascending: false });
      if (error) throw error;
      return data as MatchData[];
    },
  });

  const validMatches = matches?.filter((m) => m.home_team && m.away_team) || [];
  const byDateAsc = (a: MatchData, b: MatchData) => new Date(a.match_date).getTime() - new Date(b.match_date).getTime();
  const liveMatches = [...validMatches.filter((m) => m.is_live)].sort(byDateAsc);
  const recentMatches = [...validMatches.filter((m) => m.status === "final")].sort(byDateAsc);
  const recentToDisplay = recentMatches.slice(-Math.max(0, 4 - liveMatches.length));
  const baseDisplayMatches = [...liveMatches, ...recentToDisplay].sort(byDateAsc);
  const displayMatches = baseDisplayMatches.map((m, i) => {
    if (!previewRooms || m.home_locker_room || m.away_locker_room) return m;
    return {
      ...m,
      home_locker_room: `Chambre ${i * 2 + 1}`,
      away_locker_room: `Chambre ${i * 2 + 2}`,
    };
  });

  if (displayMatches.length === 0) {
    return (
      <div className="h-full flex flex-col justify-center items-center px-12">
        <SectionTitle title="Scores" subtitle="Aucun match pour le moment" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col justify-center px-12">
      <SectionTitle title="Scores" subtitle="Matchs en cours & récents" />
      {previewRooms && (
        <p className="text-center text-xs text-muted-foreground mb-3">
          Prévisualisation des chambres (mode local)
        </p>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-6xl mx-auto w-full">
        {displayMatches.map((m) => (
          <ScoreCard key={m.id} match={m} isLive={m.is_live} />
        ))}
      </div>
    </div>
  );
};

export default LiveScoresSection;
