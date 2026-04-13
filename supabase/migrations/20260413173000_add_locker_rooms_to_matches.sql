ALTER TABLE public.matches
ADD COLUMN IF NOT EXISTS home_locker_room text,
ADD COLUMN IF NOT EXISTS away_locker_room text;
