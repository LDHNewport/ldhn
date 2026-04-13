import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useRealtimeMatches } from "@/hooks/useRealtimeMatches";
import { ArrowLeft, Plus, Trash2, Pencil, Users, Trophy, Gamepad2, Zap, CheckCircle, Newspaper, Upload, LogOut, Lock, Unlock, ExternalLink, History } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import type { Tables } from "@/integrations/supabase/types";
import LiveMatchControl from "@/components/matches/LiveMatchControl";
import type { Session } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

type Team = Tables<"teams">;
type Player = Tables<"players">;

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
  home_coach_initials: string | null;
  away_coach_initials: string | null;
  lineup_confirmed: boolean;
  home_locker_room: string | null;
  away_locker_room: string | null;
  home_team: Team;
  away_team: Team;
}

const POSITIONS = [
  { value: "F", label: "Avant" },
  { value: "D", label: "Défenseur" },
  { value: "G", label: "Gardien" },
];

type MatchStatus = "scheduled" | "live" | "final";
type ImportRow = Record<string, unknown>;
type SheetCell = string | number | boolean | Date | null | undefined;
type SheetRow = SheetCell[];

const normalizeHeader = (key: string) =>
  key
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const rowToNormalizedMap = (row: ImportRow) => {
  const normalized: ImportRow = {};
  Object.entries(row).forEach(([key, value]) => {
    normalized[normalizeHeader(key)] = value;
  });
  return normalized;
};

const pickRowValue = (row: ImportRow, keys: string[]) => {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
};

const parseOptionalNumber = (value: unknown, rowNumber: number, label: string) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const num = Number(value);
  if (Number.isNaN(num)) throw new Error(`Ligne ${rowNumber}: valeur invalide pour "${label}"`);
  return Math.round(num);
};

const parseOptionalBoolean = (value: unknown, rowNumber: number, label: string) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "oui", "vrai"].includes(normalized)) return true;
  if (["false", "0", "no", "non", "faux"].includes(normalized)) return false;
  throw new Error(`Ligne ${rowNumber}: valeur invalide pour "${label}"`);
};

const parseMatchDateCell = (value: unknown, rowNumber: number) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) throw new Error(`Ligne ${rowNumber}: date Excel invalide`);
    const date = new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H ?? 0, parsed.M ?? 0, Math.floor(parsed.S ?? 0));
    return date.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`Ligne ${rowNumber}: date de match manquante`);
    const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Ligne ${rowNumber}: format de date invalide (utilise ISO, ex: 2026-04-15 19:30)`);
    }
    return date.toISOString();
  }
  throw new Error(`Ligne ${rowNumber}: date de match invalide`);
};

const parseStatus = (value: unknown): MatchStatus => {
  const normalized = String(value ?? "scheduled").trim().toLowerCase();
  const statusMap: Record<string, MatchStatus> = {
    scheduled: "scheduled",
    programme: "scheduled",
    programmé: "scheduled",
    live: "live",
    en_cours: "live",
    en_direct: "live",
    final: "final",
    termine: "final",
    terminé: "final",
  };
  return statusMap[normalized] ?? "scheduled";
};

const TeamBadge = ({ team, size = "md" }: { team: Team; size?: "sm" | "md" }) => {
  const sizeClass = size === "sm" ? "w-8 h-8 text-[10px]" : "w-10 h-10 text-xs";

  if (team.logo_url) {
    return (
      <img
        src={team.logo_url}
        alt={`Logo ${team.name}`}
        className={`${sizeClass} rounded-full object-cover border-2 bg-background`}
        style={{ borderColor: team.color }}
      />
    );
  }

  return (
    <div className={`${sizeClass} rounded-full flex items-center justify-center font-bold border-2`} style={{ borderColor: team.color, color: team.color }}>
      {team.abbr}
    </div>
  );
};

const normalizeToken = (value: unknown) =>
  String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const normalizeTeamAlias = (value: unknown) => {
  const token = normalizeToken(value);
  return token.replace(/^(les|le|la|l)/, "");
};

const levenshtein = (a: string, b: string) => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + cost,
      );
      prev = temp;
    }
  }
  return dp[b.length];
};

const DAY_OFFSETS: Record<string, number> = {
  lundi: 0,
  mardi: 1,
  mercredi: 2,
  jeudi: 3,
  vendredi: 4,
  samedi: 5,
  dimanche: 6,
};

const MONTH_INDEX_BY_TOKEN: Record<string, number> = {
  janvier: 0,
  janv: 0,
  jan: 0,
  fevrier: 1,
  fev: 1,
  fevr: 1,
  mars: 2,
  avril: 3,
  avr: 3,
  av: 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  juil: 6,
  aout: 7,
  septembre: 8,
  sept: 8,
  octobre: 9,
  oct: 9,
  novembre: 10,
  nov: 10,
  decembre: 11,
  dec: 11,
};

const parseWeekStartCell = (cell: SheetCell, defaultYear: number) => {
  const raw = String(cell ?? "").trim();
  if (!raw) return null;
  const normalized = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (!normalized.includes("sem") || !normalized.includes("au")) return null;

  const match = normalized.match(/(\d{1,2})\s*au\s*(\d{1,2})?\s*([a-z.]+)/);
  if (!match) return null;

  const day = Number(match[1]);
  const monthToken = normalizeToken(match[3]);
  const monthIndex = MONTH_INDEX_BY_TOKEN[monthToken];
  if (Number.isNaN(day) || monthIndex === undefined) return null;

  return new Date(defaultYear, monthIndex, day, 0, 0, 0, 0);
};

const parseTimeRangeStart = (cell: SheetCell) => {
  const raw = String(cell ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/(\d{1,2})h(?:([0-9]{1,2}))?/i);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? "0");
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return { hours, minutes };
};

const hasValue = (cell: SheetCell) => String(cell ?? "").trim() !== "";

const isSplitArenaScheduleLayout = (gridRows: SheetRow[]) => {
  const header = gridRows[0] ?? [];
  const h0 = normalizeToken(header[0]);
  const h1 = normalizeToken(header[1]);
  const h2 = normalizeToken(header[2]);
  const h3 = normalizeToken(header[3]);
  const h5 = normalizeToken(header[5]);
  const looksLikeClassicHeader = h0 === "date" && h1 === "heure" && h2 === "division" && (h3.includes("quipe") || h3.includes("team")) && (h5.includes("quipe") || h5.includes("team"));
  if (!looksLikeClassicHeader) return false;

  // Right-side block has empty header keys in this format but data in column 7+.
  return gridRows.slice(1).some((row) => hasValue(row[7]) || hasValue(row[8]) || hasValue(row[10]));
};

const parseSplitArenaScheduleRows = ({
  gridRows,
  resolveTeamId,
}: {
  gridRows: SheetRow[];
  resolveTeamId: (rawValue: unknown, rowNumber: number, label: string) => string;
}) => {
  const defaultYear = new Date().getFullYear();
  const contexts = [
    { weekStart: null as Date | null, dayLabel: "" },
    { weekStart: null as Date | null, dayLabel: "" },
  ];
  const parsed: Record<string, unknown>[] = [];

  for (let rowIndex = 1; rowIndex < gridRows.length; rowIndex += 1) {
    const row = gridRows[rowIndex] ?? [];

    [0, 7].forEach((offset, blockIndex) => {
      const blockLabel = blockIndex === 0 ? "bloc gauche" : "bloc droit";
      const ctx = contexts[blockIndex];

      const dateCell = row[offset];
      const timeCell = row[offset + 1];
      const homeTeamCell = row[offset + 3];
      const homeRoomCell = row[offset + 4];
      const awayTeamCell = row[offset + 5];
      const awayRoomCell = row[offset + 6];

      if (![dateCell, timeCell, homeTeamCell, awayTeamCell, homeRoomCell, awayRoomCell].some(hasValue)) return;

      const weekStart = parseWeekStartCell(dateCell, defaultYear);
      if (weekStart) {
        ctx.weekStart = weekStart;
        ctx.dayLabel = "";
        return;
      }

      if (hasValue(dateCell)) {
        ctx.dayLabel = String(dateCell).trim();
      }

      const homeRaw = String(homeTeamCell ?? "").trim();
      const awayRaw = String(awayTeamCell ?? "").trim();
      if (!homeRaw || !awayRaw) return;

      if (!ctx.weekStart) {
        throw new Error(`Ligne ${rowIndex + 1}: semaine introuvable avant match (${blockLabel}).`);
      }
      if (!ctx.dayLabel) {
        throw new Error(`Ligne ${rowIndex + 1}: jour introuvable avant match (${blockLabel}).`);
      }

      const dayKey = normalizeToken(ctx.dayLabel);
      const dayOffset = DAY_OFFSETS[dayKey];
      if (dayOffset === undefined) {
        throw new Error(`Ligne ${rowIndex + 1}: jour invalide "${ctx.dayLabel}" (${blockLabel}).`);
      }

      const timeStart = parseTimeRangeStart(timeCell);
      if (!timeStart) {
        throw new Error(`Ligne ${rowIndex + 1}: heure invalide "${String(timeCell ?? "")}" (${blockLabel}).`);
      }

      const homeTeamId = resolveTeamId(homeRaw, rowIndex + 1, `équipe locale (${blockLabel})`);
      const awayTeamId = resolveTeamId(awayRaw, rowIndex + 1, `équipe visiteuse (${blockLabel})`);
      if (homeTeamId === awayTeamId) {
        throw new Error(`Ligne ${rowIndex + 1}: les deux équipes sont identiques (${blockLabel}).`);
      }

      const matchDate = new Date(ctx.weekStart);
      matchDate.setDate(ctx.weekStart.getDate() + dayOffset);
      matchDate.setHours(timeStart.hours, timeStart.minutes, 0, 0);

      parsed.push({
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        match_date: matchDate.toISOString(),
        status: "scheduled",
        is_live: false,
        home_locker_room: String(homeRoomCell ?? "").trim() || null,
        away_locker_room: String(awayRoomCell ?? "").trim() || null,
      });
    });
  }

  return parsed;
};

// ─── Teams Tab ───────────────────────────────────────────────
const TeamsTab = () => {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [abbr, setAbbr] = useState("");
  const [color, setColor] = useState("#00cc55");
  const [division, setDivision] = useState("rookies");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploading, setLogoUploading] = useState(false);

  const { data: teams, isLoading } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data, error } = await supabase.from("teams").select("*").order("name");
      if (error) throw error;
      return data as Team[];
    },
  });

  const upsert = useMutation({
    mutationFn: async () => {
      const payload = { name, abbr: abbr.toUpperCase(), color, division, logo_url: logoUrl || null };
      if (editId) {
        const { error } = await supabase.from("teams").update(payload).eq("id", editId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("teams").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["teams"] });
      setOpen(false);
      resetForm();
      toast({ title: editId ? "Équipe modifiée" : "Équipe créée" });
    },
    onError: (e) => toast({ title: "Erreur", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("teams").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["teams"] }); toast({ title: "Supprimée" }); },
  });

  const resetForm = () => { setEditId(null); setName(""); setAbbr(""); setColor("#00cc55"); setDivision("rookies"); setLogoUrl(""); };

  const startEdit = (t: Team) => {
    setEditId(t.id); setName(t.name); setAbbr(t.abbr); setColor(t.color); setDivision(t.division); setLogoUrl(t.logo_url || ""); setOpen(true);
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoUploading(true);
    const ext = file.name.split(".").pop();
    const path = `teams/${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from("media").upload(path, file);
    if (error) {
      toast({ title: "Erreur upload logo", variant: "destructive" });
      setLogoUploading(false);
      e.target.value = "";
      return;
    }
    const { data: urlData } = supabase.storage.from("media").getPublicUrl(path);
    setLogoUrl(urlData.publicUrl);
    setLogoUploading(false);
    e.target.value = "";
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="font-display text-2xl font-bold text-foreground">Équipes</h2>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> Nouvelle équipe</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{editId ? "Modifier l'équipe" : "Nouvelle équipe"}</DialogTitle></DialogHeader>
            <form onSubmit={(e) => { e.preventDefault(); upsert.mutate(); }} className="space-y-4">
              <div><Label>Nom</Label><Input value={name} onChange={(e) => setName(e.target.value)} required /></div>
              <div><Label>Abréviation (3 lettres)</Label><Input value={abbr} onChange={(e) => setAbbr(e.target.value)} maxLength={4} required /></div>
              <div><Label>Couleur</Label><Input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></div>
              <div>
                <Label>Logo (optionnel)</Label>
                <div className="flex gap-2 items-center">
                  <Input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="URL ou upload" className="flex-1" />
                  <Label htmlFor="team-logo-upload" className="cursor-pointer">
                    <div className="inline-flex items-center gap-1 px-3 py-2 rounded-md bg-secondary text-secondary-foreground text-sm hover:bg-secondary/80">
                      <Upload className="h-4 w-4" /> {logoUploading ? "..." : "Upload"}
                    </div>
                  </Label>
                  <input id="team-logo-upload" type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
                </div>
                {logoUrl && <img src={logoUrl} alt="Aperçu logo" className="mt-2 h-16 w-16 object-cover rounded-full border border-border" />}
              </div>
              <div>
                <Label>Division</Label>
                <Select value={division} onValueChange={setDivision}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rookies">Les Rookies</SelectItem>
                    <SelectItem value="younguns">Les Young Guns</SelectItem>
                    <SelectItem value="veterans">Les Vétérans</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" className="w-full" disabled={upsert.isPending || !name || !abbr}>
                {upsert.isPending ? "..." : editId ? "Modifier" : "Créer"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? <p className="text-muted-foreground">Chargement...</p> : (
        <div className="grid gap-3 sm:grid-cols-2">
          {teams?.map((t) => (
            <Card key={t.id} className="border-l-4" style={{ borderLeftColor: t.color }}>
              <CardContent className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <TeamBadge team={t} />
                  <span className="font-semibold">{t.name}</span>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => startEdit(t)}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => remove.mutate(t.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Players Tab ─────────────────────────────────────────────
const PlayersTab = () => {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [number, setNumber] = useState("");
  const [position, setPosition] = useState("F");
  const [teamId, setTeamId] = useState("");
  const [photoUrl, setPhotoUrl] = useState("");
  const [filterTeam, setFilterTeam] = useState<string>("all");

  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data, error } = await supabase.from("teams").select("*").order("name");
      if (error) throw error;
      return data as Team[];
    },
  });

  const { data: players, isLoading } = useQuery({
    queryKey: ["players-all"],
    queryFn: async () => {
      const { data, error } = await supabase.from("players").select("*, team:teams(*)").order("last_name");
      if (error) throw error;
      return data as (Player & { team: Team })[];
    },
  });

  const upsert = useMutation({
    mutationFn: async () => {
      const payload = {
        first_name: firstName,
        last_name: lastName,
        number: parseInt(number),
        position,
        team_id: teamId,
        photo_url: photoUrl || null,
      };
      if (editId) {
        const { error } = await supabase.from("players").update(payload).eq("id", editId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("players").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["players-all"] });
      setOpen(false);
      resetForm();
      toast({ title: editId ? "Joueur modifié" : "Joueur créé" });
    },
    onError: (e) => toast({ title: "Erreur", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("players").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["players-all"] }); toast({ title: "Supprimé" }); },
  });

  const resetForm = () => { setEditId(null); setFirstName(""); setLastName(""); setNumber(""); setPosition("F"); setTeamId(""); setPhotoUrl(""); };

  const startEdit = (p: Player & { team: Team }) => {
    setEditId(p.id); setFirstName(p.first_name); setLastName(p.last_name); setNumber(String(p.number)); setPosition(p.position); setTeamId(p.team_id); setPhotoUrl((p as any).photo_url || ""); setOpen(true);
  };

  const filtered = filterTeam === "all" ? players : players?.filter((p) => p.team_id === filterTeam);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between items-center gap-2">
        <h2 className="font-display text-2xl font-bold text-foreground">Joueurs</h2>
        <div className="flex gap-2">
          <Select value={filterTeam} onValueChange={setFilterTeam}>
            <SelectTrigger className="w-40 h-9 text-xs"><SelectValue placeholder="Filtrer" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Toutes les équipes</SelectItem>
              {teams?.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
            <DialogTrigger asChild>
              <Button className="gap-2"><Plus className="h-4 w-4" /> Nouveau joueur</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>{editId ? "Modifier le joueur" : "Nouveau joueur"}</DialogTitle></DialogHeader>
              <form onSubmit={(e) => { e.preventDefault(); upsert.mutate(); }} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>Prénom</Label><Input value={firstName} onChange={(e) => setFirstName(e.target.value)} required /></div>
                  <div><Label>Nom</Label><Input value={lastName} onChange={(e) => setLastName(e.target.value)} required /></div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>Numéro</Label><Input type="number" value={number} onChange={(e) => setNumber(e.target.value)} required /></div>
                  <div>
                    <Label>Position</Label>
                    <Select value={position} onValueChange={setPosition}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{POSITIONS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label>Équipe</Label>
                  <Select value={teamId} onValueChange={setTeamId}>
                    <SelectTrigger><SelectValue placeholder="Sélectionner..." /></SelectTrigger>
                    <SelectContent>{teams?.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div><Label>Photo URL (optionnel)</Label><Input value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} placeholder="https://..." /></div>
                <Button type="submit" className="w-full" disabled={upsert.isPending || !firstName || !lastName || !number || !teamId}>
                  {upsert.isPending ? "..." : editId ? "Modifier" : "Créer"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {isLoading ? <p className="text-muted-foreground">Chargement...</p> : (
        <div className="space-y-2">
          {filtered?.map((p) => (
            <Card key={p.id}>
              <CardContent className="flex items-center justify-between p-3">
                <div className="flex items-center gap-3">
                  {(p as any).photo_url ? (
                    <img src={(p as any).photo_url} alt="" className="w-10 h-10 rounded-full object-cover border-2 border-border" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-xs font-bold text-muted-foreground">
                      #{p.number}
                    </div>
                  )}
                  <div>
                    <span className="font-semibold text-sm">{p.first_name} {p.last_name}</span>
                    <div className="text-xs text-muted-foreground">
                      #{p.number} · {POSITIONS.find((pos) => pos.value === p.position)?.label || p.position} · <span style={{ color: p.team.color }}>{p.team.name}</span>
                    </div>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => startEdit(p)}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => remove.mutate(p.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {filtered?.length === 0 && <p className="text-muted-foreground text-center py-8">Aucun joueur trouvé</p>}
        </div>
      )}
    </div>
  );
};

// ─── Matches Tab ─────────────────────────────────────────────
const MatchesTab = () => {
  const { toast } = useToast();
  const qc = useQueryClient();
  useRealtimeMatches();
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [replaceCalendar, setReplaceCalendar] = useState(false);
  const [homeTeamId, setHomeTeamId] = useState("");
  const [awayTeamId, setAwayTeamId] = useState("");
  const [matchDate, setMatchDate] = useState("");
  const [homeLockerRoom, setHomeLockerRoom] = useState("");
  const [awayLockerRoom, setAwayLockerRoom] = useState("");
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data, error } = await supabase.from("teams").select("*").order("name");
      if (error) throw error;
      return data as Team[];
    },
  });

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

  const createMatch = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("matches").insert({
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        match_date: matchDate || new Date().toISOString(),
        home_locker_room: homeLockerRoom || null,
        away_locker_room: awayLockerRoom || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["matches"] });
      setOpen(false); setHomeTeamId(""); setAwayTeamId(""); setMatchDate(""); setHomeLockerRoom(""); setAwayLockerRoom("");
      toast({ title: "Match créé" });
    },
    onError: (e) => toast({ title: "Erreur", description: e.message, variant: "destructive" }),
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      // Block going live if lineup not locked
      if (status === "live") {
        const { data: appr } = await supabase.from("lineup_approvals").select("locked").eq("match_id", id).maybeSingle();
        if (!appr?.locked) {
          throw new Error("L'alignement doit être verrouillé avant de passer en direct");
        }
      }
      const update: Record<string, unknown> = { status, is_live: status === "live" };
      if (status === "live") update.lineup_confirmed = true;
      const { error } = await supabase.from("matches").update(update).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["matches"] }),
    onError: (e) => toast({ title: "Erreur", description: e.message, variant: "destructive" }),
  });

  const deleteMatch = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("matches").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["matches"] }); toast({ title: "Match supprimé" }); },
  });

  const importSchedule = useMutation({
    mutationFn: async (file: File) => {
      if (!teams || teams.length === 0) {
        throw new Error("Aucune équipe disponible. Crée les équipes avant l'import.");
      }

      const teamLookup = new Map<string, string>();
      const aliasEntries: Array<{ alias: string; teamId: string }> = [];
      teams.forEach((team) => {
        const rawName = team.name.trim();
        const nameToken = normalizeToken(rawName);
        const aliasToken = normalizeTeamAlias(rawName);
        const lastWordToken = normalizeTeamAlias(rawName.split(/\s+/).pop() ?? "");
        const candidates = [
          team.id.trim().toLowerCase(),
          team.abbr.trim().toLowerCase(),
          rawName.toLowerCase(),
          nameToken,
          aliasToken,
          lastWordToken,
        ];
        candidates.forEach((candidate) => {
          if (!candidate) return;
          teamLookup.set(candidate, team.id);
          aliasEntries.push({ alias: candidate, teamId: team.id });
        });
      });

      const resolveTeamId = (rawValue: unknown, rowNumber: number, label: string) => {
        const raw = String(rawValue).trim();
        const direct = teamLookup.get(raw.toLowerCase());
        if (direct) return direct;

        const normalized = normalizeTeamAlias(raw);
        const normalizedHit = teamLookup.get(normalized) || teamLookup.get(normalizeToken(raw));
        if (normalizedHit) return normalizedHit;

        const fuzzy = [...teamLookup.entries()].find(([alias]) => alias.endsWith(normalized) || normalized.endsWith(alias));
        if (fuzzy) return fuzzy[1];

        const fuzzyScored = aliasEntries
          .map((entry) => ({
            ...entry,
            score: levenshtein(entry.alias, normalized),
          }))
          .filter((entry) => entry.score <= Math.max(1, Math.floor(normalized.length * 0.25)))
          .sort((a, b) => a.score - b.score);

        if (fuzzyScored.length > 0) {
          const best = fuzzyScored[0];
          const isAmbiguous = fuzzyScored.length > 1 && fuzzyScored[1].score === best.score && fuzzyScored[1].teamId !== best.teamId;
          if (!isAmbiguous) return best.teamId;
        }

        throw new Error(`Ligne ${rowNumber}: ${label} inconnue ("${rawValue}")`);
      };

      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) throw new Error("Le fichier importé est vide.");
      const worksheet = workbook.Sheets[firstSheetName];
      const gridRows = XLSX.utils.sheet_to_json<SheetRow>(worksheet, { header: 1, defval: "" });
      if (gridRows.length === 0) throw new Error("Aucune ligne trouvée dans le fichier.");

      const inserts: Record<string, unknown>[] = [];
      const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];

      if (isSplitArenaScheduleLayout(gridRows)) {
        // Special LDHN schedule format: two weekly blocks side-by-side with day/time + rooms.
        inserts.push(...parseSplitArenaScheduleRows({ gridRows, resolveTeamId }));
      } else {
        const rows = XLSX.utils.sheet_to_json<ImportRow>(worksheet, { defval: "" });
        if (rows.length === 0) throw new Error("Aucune ligne exploitable trouvée dans le fichier.");

        rows.forEach((rawRow, index) => {
          const rowNumber = index + 2;
          const row = rowToNormalizedMap(rawRow);

          const homeRaw = pickRowValue(row, ["home_team", "home", "equipe_locale", "local", "domicile", "home_team_id", "home_abbr"]);
          const awayRaw = pickRowValue(row, ["away_team", "away", "equipe_visiteuse", "visiteur", "away_team_id", "away_abbr"]);
          const dateRaw = pickRowValue(row, ["match_date", "date", "date_match", "date_du_match", "datetime"]);

          if (homeRaw === undefined || awayRaw === undefined || dateRaw === undefined) {
            throw new Error(`Ligne ${rowNumber}: colonnes requises manquantes (home_team, away_team, match_date).`);
          }

          const homeId = resolveTeamId(homeRaw, rowNumber, "équipe locale");
          const awayId = resolveTeamId(awayRaw, rowNumber, "équipe visiteuse");
          if (homeId === awayId) throw new Error(`Ligne ${rowNumber}: les deux équipes sont identiques.`);

          const status = parseStatus(pickRowValue(row, ["status", "etat", "state"]));
          const homeScore = parseOptionalNumber(pickRowValue(row, ["home_score", "score_home", "score_local"]), rowNumber, "home_score");
          const awayScore = parseOptionalNumber(pickRowValue(row, ["away_score", "score_away", "score_visiteur"]), rowNumber, "away_score");
          const isLive = parseOptionalBoolean(pickRowValue(row, ["is_live", "live", "en_direct"]), rowNumber, "is_live");
          const periodRaw = pickRowValue(row, ["period", "periode"]);
          const homeLockerRoomRaw = pickRowValue(row, ["home_locker_room", "home_room", "locker_home", "chambre_locale", "vestiaire_local", "chambre_local"]);
          const awayLockerRoomRaw = pickRowValue(row, ["away_locker_room", "away_room", "locker_away", "chambre_visiteuse", "vestiaire_visiteur", "chambre_visiteur"]);

          const payload: Record<string, unknown> = {
            home_team_id: homeId,
            away_team_id: awayId,
            match_date: parseMatchDateCell(dateRaw, rowNumber),
            status,
            is_live: status === "live",
          };

          if (homeScore !== undefined) payload.home_score = homeScore;
          if (awayScore !== undefined) payload.away_score = awayScore;
          if (isLive !== undefined) payload.is_live = isLive;
          if (periodRaw !== undefined) payload.period = String(periodRaw).trim() || null;
          if (homeLockerRoomRaw !== undefined) payload.home_locker_room = String(homeLockerRoomRaw).trim() || null;
          if (awayLockerRoomRaw !== undefined) payload.away_locker_room = String(awayLockerRoomRaw).trim() || null;

          const rowId = String(pickRowValue(row, ["id", "match_id"]) ?? "").trim();
          if (!replaceCalendar && rowId) {
            updates.push({ id: rowId, payload });
          } else {
            inserts.push(payload);
          }
        });
      }

      if (inserts.length === 0 && updates.length === 0) {
        throw new Error("Aucun match valide détecté dans le fichier.");
      }

      if (replaceCalendar) {
        const { error: deleteError } = await supabase
          .from("matches")
          .delete()
          .neq("id", "00000000-0000-0000-0000-000000000000");
        if (deleteError) throw deleteError;
      }

      const chunkSize = 100;
      for (let i = 0; i < inserts.length; i += chunkSize) {
        const { error } = await supabase.from("matches").insert(inserts.slice(i, i + chunkSize));
        if (error) throw error;
      }

      if (!replaceCalendar) {
        for (const item of updates) {
          const { error } = await supabase.from("matches").update(item.payload).eq("id", item.id);
          if (error) throw error;
        }
      }

      return { createdCount: inserts.length, updatedCount: replaceCalendar ? 0 : updates.length, replaced: replaceCalendar };
    },
    onSuccess: ({ createdCount, updatedCount, replaced }) => {
      qc.invalidateQueries({ queryKey: ["matches"] });
      setImportOpen(false);
      setReplaceCalendar(false);
      const parts = [`${createdCount} ajout${createdCount > 1 ? "s" : ""}`];
      if (updatedCount > 0) parts.push(`${updatedCount} mise${updatedCount > 1 ? "s" : ""} à jour`);
      if (replaced) parts.push("calendrier remplacé");
      toast({ title: "Import terminé", description: parts.join(" · ") });
    },
    onError: (e) => toast({ title: "Erreur d'import", description: e.message, variant: "destructive" }),
  });

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importSchedule.mutate(file);
    e.target.value = "";
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between items-center gap-2">
        <h2 className="font-display text-2xl font-bold text-foreground">Matchs</h2>
        <div className="flex gap-2">
          <Dialog open={importOpen} onOpenChange={(v) => { setImportOpen(v); if (!v) setReplaceCalendar(false); }}>
            <DialogTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Upload className="h-4 w-4" /> Importer calendrier
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader><DialogTitle>Importer CSV / Excel</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Colonnes requises: <span className="font-mono">home_team</span>, <span className="font-mono">away_team</span>, <span className="font-mono">match_date</span>.
                  Colonnes optionnelles: <span className="font-mono">id</span> (mise à jour), <span className="font-mono">status</span>, <span className="font-mono">home_score</span>, <span className="font-mono">away_score</span>, <span className="font-mono">home_locker_room</span>, <span className="font-mono">away_locker_room</span>.
                </p>
                <p className="text-xs text-muted-foreground">
                  Format LDHN supporté aussi: <span className="font-mono">Date / Heure / Équipe / Chambres / Vs Équipe / Chambre</span> (même avec deux blocs par ligne).
                </p>
                <div className="flex items-center gap-2 text-sm">
                  <input
                    id="replace-calendar"
                    type="checkbox"
                    checked={replaceCalendar}
                    onChange={(e) => setReplaceCalendar(e.target.checked)}
                    disabled={importSchedule.isPending}
                  />
                  <Label htmlFor="replace-calendar">Remplacer tout le calendrier avant import</Label>
                </div>
                <Button className="w-full gap-2" onClick={() => importInputRef.current?.click()} disabled={importSchedule.isPending}>
                  <Upload className="h-4 w-4" />
                  {importSchedule.isPending ? "Import en cours..." : "Choisir un fichier (.csv, .xlsx, .xls)"}
                </Button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  onChange={handleImportFileChange}
                />
              </div>
            </DialogContent>
          </Dialog>

          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2"><Plus className="h-4 w-4" /> Nouveau match</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Créer un match</DialogTitle></DialogHeader>
              <form onSubmit={(e) => { e.preventDefault(); createMatch.mutate(); }} className="space-y-4">
                <div>
                  <Label>Équipe locale</Label>
                  <Select value={homeTeamId} onValueChange={setHomeTeamId}>
                    <SelectTrigger><SelectValue placeholder="Sélectionner..." /></SelectTrigger>
                    <SelectContent>{teams?.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Équipe visiteuse</Label>
                  <Select value={awayTeamId} onValueChange={setAwayTeamId}>
                    <SelectTrigger><SelectValue placeholder="Sélectionner..." /></SelectTrigger>
                    <SelectContent>{teams?.filter((t) => t.id !== homeTeamId).map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div><Label>Date du match</Label><Input type="datetime-local" value={matchDate} onChange={(e) => setMatchDate(e.target.value)} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>Chambre locale (optionnel)</Label><Input value={homeLockerRoom} onChange={(e) => setHomeLockerRoom(e.target.value)} placeholder="Ex: Chambre 1" /></div>
                  <div><Label>Chambre visiteuse (optionnel)</Label><Input value={awayLockerRoom} onChange={(e) => setAwayLockerRoom(e.target.value)} placeholder="Ex: Chambre 4" /></div>
                </div>
                <Button type="submit" className="w-full" disabled={createMatch.isPending || !homeTeamId || !awayTeamId}>
                  {createMatch.isPending ? "..." : "Créer le match"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {isLoading ? <p className="text-muted-foreground">Chargement...</p> : (
        <div className="space-y-4">
          {matches?.map((match) => (
            <Card key={match.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs text-muted-foreground">
                    {new Date(match.match_date).toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" })}
                  </span>
                  <div className="flex items-center gap-2">
                    <Select value={match.status} onValueChange={(s) => updateStatus.mutate({ id: match.id, status: s })}>
                      <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="scheduled">Programmé</SelectItem>
                        <SelectItem value="live">En cours</SelectItem>
                        <SelectItem value="final">Final</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => deleteMatch.mutate(match.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="flex items-center justify-center gap-4">
                  <div className="flex items-center gap-2 flex-1 justify-end">
                    <span className="font-display text-base font-semibold">{match.home_team.name}</span>
                    <TeamBadge team={match.home_team} size="sm" />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="font-display text-3xl font-bold w-10 text-center">{match.home_score}</span>
                    <span className="text-muted-foreground">-</span>
                    <span className="font-display text-3xl font-bold w-10 text-center">{match.away_score}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-1">
                    <TeamBadge team={match.away_team} size="sm" />
                    <span className="font-display text-base font-semibold">{match.away_team.name}</span>
                  </div>
                </div>
                {(match.home_locker_room || match.away_locker_room) && (
                  <div className="mt-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1">Chambres</p>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <p><span className="font-bold">{match.home_team.abbr}</span> · {match.home_locker_room || "N/D"}</p>
                      <p><span className="font-bold">{match.away_team.abbr}</span> · {match.away_locker_room || "N/D"}</p>
                    </div>
                  </div>
                )}
                {match.is_live && (
                  <div className="text-center mt-2">
                    <span className="text-xs bg-destructive/20 text-destructive px-2 py-1 rounded-full font-bold uppercase tracking-wider">🔴 En direct</span>
                  </div>
                )}
                {match.lineup_confirmed && (
                  <div className="text-center mt-1">
                    <span className="text-[10px] text-primary flex items-center justify-center gap-1"><CheckCircle className="h-3 w-3" /> Alignement confirmé</span>
                  </div>
                )}
                <LiveMatchControl match={match} />
              </CardContent>
            </Card>
          ))}
          {matches?.length === 0 && <p className="text-muted-foreground text-center py-8">Aucun match</p>}
        </div>
      )}
    </div>
  );
};

// ─── Lineup Tab ──────────────────────────────────────────────
const LineupTab = () => {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: matches } = useQuery({
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

  const { data: approvals } = useQuery({
    queryKey: ["lineup_approvals_all"],
    queryFn: async () => {
      const { data, error } = await supabase.from("lineup_approvals").select("*");
      if (error) throw error;
      return data;
    },
  });

  const { data: auditLogs } = useQuery({
    queryKey: ["lineup_audit_log"],
    queryFn: async () => {
      const { data, error } = await supabase.from("lineup_audit_log").select("*").order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      return data;
    },
  });

  const getApproval = (matchId: string) => approvals?.find((a) => a.match_id === matchId);

  const unlockMutation = useMutation({
    mutationFn: async (matchId: string) => {
      const approval = getApproval(matchId);
      if (approval) {
        const { error } = await supabase.from("lineup_approvals").update({
          locked: false,
          home_signed_at: null,
          away_signed_at: null,
          home_coach_initials: null,
          away_coach_initials: null,
          updated_at: new Date().toISOString(),
        }).eq("id", approval.id);
        if (error) throw error;
      }
      // Insert audit log
      await supabase.from("lineup_audit_log").insert({
        match_id: matchId,
        action: "unlock",
        performed_by: "admin",
        details: "Alignement déverrouillé par admin",
      });
      // Reset match lineup_confirmed
      await supabase.from("matches").update({ lineup_confirmed: false, home_coach_initials: null, away_coach_initials: null }).eq("id", matchId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lineup_approvals_all"] });
      qc.invalidateQueries({ queryKey: ["lineup_audit_log"] });
      qc.invalidateQueries({ queryKey: ["matches"] });
      toast({ title: "🔓 Alignement déverrouillé" });
    },
  });

  const upcoming = matches?.filter((m) => m.status !== "final") || [];

  return (
    <div className="space-y-6">
      <h2 className="font-display text-2xl font-bold text-foreground">Validation alignement</h2>

      {/* Match list with lock status */}
      <div className="space-y-3">
        {upcoming.map((m) => {
          const appr = getApproval(m.id);
          const locked = appr?.locked === true;
          return (
            <Card key={m.id} className={`border-l-4 ${locked ? "border-l-primary" : "border-l-muted"}`}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-display font-bold text-sm">{m.home_team.abbr} vs {m.away_team.abbr}</span>
                    <p className="text-xs text-muted-foreground">{new Date(m.match_date).toLocaleDateString("fr-CA")}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {locked ? (
                      <span className="flex items-center gap-1 text-xs font-bold text-primary bg-primary/10 px-2 py-1 rounded">
                        <Lock className="h-3 w-3" /> VERROUILLÉ
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Non verrouillé</span>
                    )}
                  </div>
                </div>

                {/* Signature status */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className={`p-2 rounded text-center ${appr?.home_signed_at ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                    <p className="font-bold">{m.home_team.abbr}</p>
                    {appr?.home_signed_at ? (
                      <p>✅ {appr.home_coach_initials} — {new Date(appr.home_signed_at).toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" })}</p>
                    ) : (
                      <p>⏳ En attente</p>
                    )}
                  </div>
                  <div className={`p-2 rounded text-center ${appr?.away_signed_at ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                    <p className="font-bold">{m.away_team.abbr}</p>
                    {appr?.away_signed_at ? (
                      <p>✅ {appr.away_coach_initials} — {new Date(appr.away_signed_at).toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" })}</p>
                    ) : (
                      <p>⏳ En attente</p>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  <a href={`/lineup/${m.id}`} target="_blank" rel="noopener noreferrer" className="flex-1">
                    <Button variant="outline" size="sm" className="w-full gap-1 text-xs">
                      <ExternalLink className="h-3 w-3" /> Ouvrir page signature
                    </Button>
                  </a>
                  {locked && (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="gap-1 text-xs"
                      onClick={() => unlockMutation.mutate(m.id)}
                      disabled={unlockMutation.isPending}
                    >
                      <Unlock className="h-3 w-3" /> Déverrouiller
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
        {upcoming.length === 0 && <p className="text-muted-foreground text-center py-8">Aucun match à venir</p>}
      </div>

      {/* Audit log */}
      {auditLogs && auditLogs.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-display text-lg font-bold text-foreground flex items-center gap-2">
            <History className="h-4 w-4" /> Historique des modifications
          </h3>
          <div className="space-y-1">
            {auditLogs.map((log) => (
              <div key={log.id} className="text-xs bg-muted/30 rounded px-3 py-2 flex items-center justify-between">
                <span>{log.details || log.action}</span>
                <span className="text-muted-foreground">{new Date(log.created_at).toLocaleString("fr-CA")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Articles Tab ────────────────────────────────────────────
const CATEGORIES = [
  { value: "recap", label: "Résumé de match" },
  { value: "stars", label: "3 étoiles" },
  { value: "news", label: "Nouvelles" },
  { value: "project", label: "Projets à venir" },
];

const ArticlesTab = () => {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("news");
  const [imageUrl, setImageUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [published, setPublished] = useState(true);
  const [uploading, setUploading] = useState(false);

  const { data: articles = [] } = useQuery({
    queryKey: ["admin-articles"],
    queryFn: async () => {
      const { data, error } = await supabase.from("articles").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const resetForm = () => {
    setEditId(null); setTitle(""); setContent(""); setCategory("news");
    setImageUrl(""); setVideoUrl(""); setPublished(true);
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const ext = file.name.split(".").pop();
    const path = `articles/${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from("media").upload(path, file);
    if (error) { toast({ title: "Erreur upload", variant: "destructive" }); setUploading(false); return; }
    const { data: urlData } = supabase.storage.from("media").getPublicUrl(path);
    setImageUrl(urlData.publicUrl);
    setUploading(false);
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload = { title, content, category, image_url: imageUrl || null, video_url: videoUrl || null, published };
      if (editId) {
        const { error } = await supabase.from("articles").update(payload).eq("id", editId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("articles").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-articles"] });
      toast({ title: editId ? "Article modifié" : "Article créé" });
      resetForm(); setOpen(false);
    },
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("articles").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-articles"] }); },
  });

  return (
    <div className="space-y-4">
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetForm(); }}>
        <DialogTrigger asChild>
          <Button className="gap-2"><Plus className="h-4 w-4" /> Ajouter un article</Button>
        </DialogTrigger>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editId ? "Modifier" : "Nouvel"} article</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Titre</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
            <div>
              <Label>Catégorie</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Contenu</Label><Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5} /></div>
            <div>
              <Label>Image</Label>
              <div className="flex gap-2 items-center">
                <Input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="URL ou upload" className="flex-1" />
                <Label htmlFor="img-upload" className="cursor-pointer">
                  <div className="inline-flex items-center gap-1 px-3 py-2 rounded-md bg-secondary text-secondary-foreground text-sm hover:bg-secondary/80">
                    <Upload className="h-4 w-4" /> {uploading ? "..." : "Upload"}
                  </div>
                </Label>
                <input id="img-upload" type="file" accept="image/*" className="hidden" onChange={handleUpload} />
              </div>
              {imageUrl && <img src={imageUrl} alt="preview" className="mt-2 h-32 object-cover rounded-lg" />}
            </div>
            <div><Label>URL vidéo (YouTube embed)</Label><Input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://youtube.com/embed/..." /></div>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} id="pub" />
              <Label htmlFor="pub">Publié</Label>
            </div>
            <Button onClick={() => save.mutate()} disabled={!title} className="w-full">
              {editId ? "Modifier" : "Créer"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="space-y-3">
        {articles.map((a) => (
          <Card key={a.id} className="border-border">
            <CardContent className="p-4 flex items-center gap-4">
              {a.image_url && <img src={a.image_url} alt="" className="w-16 h-16 rounded-lg object-cover shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-display font-bold text-foreground truncate">{a.title}</span>
                  {!a.published && <span className="text-xs text-muted-foreground">(brouillon)</span>}
                </div>
                <span className="text-xs text-muted-foreground">
                  {CATEGORIES.find((c) => c.value === a.category)?.label} · {new Date(a.created_at).toLocaleDateString("fr-CA")}
                </span>
              </div>
              <Button variant="ghost" size="icon" onClick={() => {
                setEditId(a.id); setTitle(a.title); setContent(a.content || "");
                setCategory(a.category); setImageUrl(a.image_url || "");
                setVideoUrl(a.video_url || ""); setPublished(a.published); setOpen(true);
              }}><Pencil className="h-4 w-4" /></Button>
              <Button variant="ghost" size="icon" onClick={() => del.mutate(a.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};

// ─── Login Form ──────────────────────────────────────────────
const AdminLogin = ({ onLogin }: { onLogin: () => void }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    if (isSignUp) {
      const { error: err } = await supabase.auth.signUp({ email, password });
      if (err) {
        setError(err.message);
        setLoading(false);
      } else {
        toast({ title: "Compte créé avec succès !" });
        setIsSignUp(false);
        // Auto-login after signup (auto-confirm is enabled)
        const { error: loginErr } = await supabase.auth.signInWithPassword({ email, password });
        if (loginErr) {
          setError("Compte créé, veuillez vous connecter.");
        } else {
          onLogin();
        }
        setLoading(false);
      }
    } else {
      const { error: err } = await supabase.auth.signInWithPassword({ email, password });
      if (err) {
        setError("Identifiants invalides");
        setLoading(false);
      } else {
        onLogin();
      }
    }
  };

  return (
    <div className="min-h-screen bg-arena-gradient flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center font-display text-2xl">
            Admin — {isSignUp ? "Créer un compte" : "Connexion"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Courriel</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Mot de passe</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (isSignUp ? "Création…" : "Connexion…") : (isSignUp ? "Créer le compte" : "Se connecter")}
            </Button>
            <Button type="button" variant="link" className="w-full" onClick={() => { setIsSignUp(!isSignUp); setError(""); }}>
              {isSignUp ? "Déjà un compte ? Se connecter" : "Créer un nouveau compte"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

// ─── Main Admin Page ─────────────────────────────────────────
const Admin = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setLoading(false);
    });
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  if (loading) return <div className="min-h-screen bg-arena-gradient flex items-center justify-center"><span className="text-muted-foreground">Chargement…</span></div>;
  if (!session) return <AdminLogin onLogin={() => {}} />;

  return (
    <div className="min-h-screen bg-arena-gradient p-4 sm:p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Link to="/">
            <Button variant="ghost" size="icon"><ArrowLeft className="h-5 w-5" /></Button>
          </Link>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-neon">Admin</h1>
          <div className="ml-auto">
            <Button variant="outline" size="sm" onClick={() => supabase.auth.signOut()}>
              <LogOut className="h-4 w-4 mr-1" /> Déconnexion
            </Button>
          </div>
        </div>

        <Tabs defaultValue="teams" className="space-y-4">
          <TabsList className="grid grid-cols-5 w-full bg-secondary/50">
            <TabsTrigger value="teams" className="gap-1 text-xs sm:text-sm"><Users className="h-4 w-4 hidden sm:block" /> Équipes</TabsTrigger>
            <TabsTrigger value="players" className="gap-1 text-xs sm:text-sm"><Trophy className="h-4 w-4 hidden sm:block" /> Joueurs</TabsTrigger>
            <TabsTrigger value="matches" className="gap-1 text-xs sm:text-sm"><Gamepad2 className="h-4 w-4 hidden sm:block" /> Matchs</TabsTrigger>
            <TabsTrigger value="lineup" className="gap-1 text-xs sm:text-sm"><Zap className="h-4 w-4 hidden sm:block" /> Alignement</TabsTrigger>
            <TabsTrigger value="articles" className="gap-1 text-xs sm:text-sm"><Newspaper className="h-4 w-4 hidden sm:block" /> Reportage</TabsTrigger>
          </TabsList>
          <TabsContent value="teams"><TeamsTab /></TabsContent>
          <TabsContent value="players"><PlayersTab /></TabsContent>
          <TabsContent value="matches"><MatchesTab /></TabsContent>
          <TabsContent value="lineup"><LineupTab /></TabsContent>
          <TabsContent value="articles"><ArticlesTab /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

export default Admin;
