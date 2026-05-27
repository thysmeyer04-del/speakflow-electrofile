-- Speakflow user_knowledge — vector-embedded transcript index for RAG.
--
-- Codex-hardened version: split policies, locked search_path, auth.uid()
-- assertion in the match function.

-- 1. Enable pgvector
create extension if not exists vector;

-- 2. Table
create table if not exists public.user_knowledge (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  content text not null,
  embedding vector(384), -- all-MiniLM-L6-v2 dimension
  metadata jsonb not null default '{}'::jsonb
);

-- 3. RLS — explicit per-operation, scoped to authenticated users only.
alter table public.user_knowledge enable row level security;

drop policy if exists "Users can manage their own knowledge" on public.user_knowledge;
drop policy if exists "Users can view own knowledge" on public.user_knowledge;
drop policy if exists "Users can insert own knowledge" on public.user_knowledge;
drop policy if exists "Users can delete own knowledge" on public.user_knowledge;

create policy "Users can view own knowledge"
  on public.user_knowledge for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert own knowledge"
  on public.user_knowledge for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can delete own knowledge"
  on public.user_knowledge for delete
  to authenticated
  using (auth.uid() = user_id);

-- (Deliberately no UPDATE policy — embedded transcripts are append-only.)

-- 4. Indexing
-- A. HNSW vector index for ANN search.
create index if not exists user_knowledge_embedding_hnsw
  on public.user_knowledge using hnsw (embedding vector_cosine_ops);

-- B. Composite B-tree for the recent-rows "warm path" per user.
create index if not exists user_knowledge_user_recent
  on public.user_knowledge (user_id, created_at desc, id);

-- 5. Semantic search RPC. SECURITY INVOKER (default) so RLS still applies.
-- Asserts p_user_id matches the caller so a user can't search someone else.
create or replace function public.match_user_knowledge(
  query_embedding vector(384),
  match_threshold float,
  match_count int,
  p_user_id uuid
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_user_id is null or p_user_id <> auth.uid() then
    raise exception 'p_user_id must match auth.uid()';
  end if;

  return query
  select
    k.id,
    k.content,
    k.metadata,
    1 - (k.embedding <=> query_embedding) as similarity
  from public.user_knowledge k
  where k.user_id = p_user_id
    and 1 - (k.embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
end;
$$;

revoke execute on function public.match_user_knowledge(vector, float, int, uuid) from anon, public;
grant execute on function public.match_user_knowledge(vector, float, int, uuid) to authenticated;
