export default function Loading() {
  return (
    <div className="flex min-h-[50vh] w-full flex-col gap-4 px-4 py-8">
      <div className="h-8 w-64 animate-pulse rounded-md bg-muted" />
      <div className="h-10 w-full max-w-md animate-pulse rounded-md bg-muted" />
      <div className="h-64 w-full animate-pulse rounded-lg bg-muted/80" />
    </div>
  );
}
