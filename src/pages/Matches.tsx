import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";
import { useRealtimeMatches } from "@/hooks/useRealtimeMatches";

type Team = Tables<"teams">;

interface MatchWithTeams {
  id: string;
  home_score: number;
  away_score: number;
  status: string;
  period: string | null;
  match_date: string;
  is_live: boolean;
  home_team_id: string;
  away_team_id: string;
  home_team: Team;
  away_team: Team;
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: "Programmé",
  live: "En cours",
  final: "Final",
};

const Matches = () => {
  useRealtimeMatches();

  const { data: matches, isLoading } = useQuery({
    queryKey: ["matches"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matches")
        .select("*, home_team:teams!matches_home_team_id_fkey(*), away_team:teams!matches_away_team_id_fkey(*)")
        .order("match_date", { ascending: true });
      if (error) throw error;
      return data as MatchWithTeams[];
    },
  });

  return (
    <div className="min-h-screen bg-arena-gradient p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-4 mb-8">
          <Link to="/">
            <Button variant="ghost" size="icon"><ArrowLeft className="h-5 w-5" /></Button>
          </Link>
          <h1 className="font-display text-4xl font-bold text-neon">Matchs</h1>
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-center">Chargement...</p>
        ) : matches?.length === 0 ? (
          <p className="text-muted-foreground text-center text-lg">Aucun match pour le moment.</p>
        ) : (
          <div className="space-y-4">
            {matches?.map((match) => (
              <div key={match.id} className="bg-card rounded-xl border border-border p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-muted-foreground">
                    {new Date(match.match_date).toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" })}
                  </span>
                  <span className="text-xs font-semibold px-2 py-1 rounded-full bg-muted text-muted-foreground">
                    {STATUS_LABELS[match.status] || match.status}
                  </span>
                </div>
                <div className="flex items-center justify-center gap-6">
                  <div className="flex items-center gap-3 flex-1 justify-end">
                    <span className="font-display text-lg font-semibold">{match.home_team.name}</span>
                    <div className="w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold" style={{ borderColor: match.home_team.color, color: match.home_team.color }}>
                      {match.home_team.abbr}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-display text-4xl font-bold w-12 text-center">{match.home_score}</span>
                    <span className="font-display text-2xl text-muted-foreground">-</span>
                    <span className="font-display text-4xl font-bold w-12 text-center">{match.away_score}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold" style={{ borderColor: match.away_team.color, color: match.away_team.color }}>
                      {match.away_team.abbr}
                    </div>
                    <span className="font-display text-lg font-semibold">{match.away_team.name}</span>
                  </div>
                </div>
                {match.is_live && (
                  <div className="text-center mt-2">
                    <span className="text-xs bg-arena-red/20 text-arena-red px-2 py-1 rounded-full font-bold uppercase tracking-wider">🔴 En direct</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Matches;
