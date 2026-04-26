"use client";

import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type SavedFolder,
  useFundingUiStore,
} from "@/features/funding-table/funding-ui-store";
import { cn } from "@/lib/utils";

function folderSortId(id: string) {
  return `FOLDER|${id}`;
}

function tokenSortId(section: string, base: string) {
  return `TOKEN|${section}|${base}`;
}

function parseDragId(id: string):
  | { kind: "folder"; folderId: string }
  | { kind: "token"; section: string; base: string }
  | null {
  if (id.startsWith("FOLDER|")) {
    return { kind: "folder", folderId: id.slice(7) };
  }
  if (id.startsWith("TOKEN|")) {
    const rest = id.slice(6);
    const i = rest.indexOf("|");
    if (i < 0) return null;
    return {
      kind: "token",
      section: rest.slice(0, i),
      base: rest.slice(i + 1),
    };
  }
  return null;
}

function FolderPicker({
  base,
  currentFolderId,
  folderOptions,
}: {
  base: string;
  currentFolderId: string | null;
  folderOptions: { id: string; name: string }[];
}) {
  const setSavedTokenFolder = useFundingUiStore((s) => s.setSavedTokenFolder);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const currentLabel =
    currentFolderId === null
      ? "Без папки"
      : (folderOptions.find((f) => f.id === currentFolderId)?.name ?? "Папка");

  const filteredFolders = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return folderOptions;
    return folderOptions.filter((f) => f.name.toLowerCase().includes(q));
  }, [folderOptions, filter]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setFilter("");
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setFilter("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (folderId: string | null) => {
    setSavedTokenFolder(base, folderId);
    setOpen(false);
    setFilter("");
  };

  const showSearch = folderOptions.length > 5;

  return (
    <div
      ref={rootRef}
      className="relative min-w-0 flex-1 max-w-[min(100%,240px)]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        id={`folder-picker-${base}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="h-8 w-full min-w-0 justify-between gap-1 px-2 font-normal"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="min-w-0 truncate text-left text-xs">{currentLabel}</span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 opacity-60 transition-transform",
            open && "rotate-180",
          )}
        />
      </Button>
      {open ? (
        <div
          role="listbox"
          aria-labelledby={`folder-picker-${base}`}
          className="absolute left-0 top-full z-[100] mt-1 w-[min(280px,calc(100vw-2rem))] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          {showSearch ? (
            <div className="border-b border-border p-1.5">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Найти папку…"
                className="h-7 text-xs"
                autoFocus
                onPointerDown={(e) => e.stopPropagation()}
              />
            </div>
          ) : null}
          <div className="max-h-[min(220px,38vh)] overflow-y-auto overscroll-contain py-1">
            <button
              type="button"
              role="option"
              aria-selected={currentFolderId === null}
              className={cn(
                "flex w-full px-2.5 py-1.5 text-left text-xs hover:bg-muted/80",
                currentFolderId === null && "bg-muted/50 font-medium",
              )}
              onClick={() => pick(null)}
            >
              Без папки
            </button>
            {filteredFolders.length === 0 ? (
              <div className="px-2.5 py-2 text-xs text-muted-foreground">
                Нет папок по запросу
              </div>
            ) : (
              filteredFolders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="option"
                  aria-selected={currentFolderId === f.id}
                  className={cn(
                    "flex w-full px-2.5 py-1.5 text-left text-xs hover:bg-muted/80",
                    currentFolderId === f.id && "bg-muted/50 font-medium",
                  )}
                  onClick={() => pick(f.id)}
                >
                  <span className="truncate">{f.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SortableFolderRow({
  folder,
  onStartRename,
}: {
  folder: SavedFolder;
  onStartRename: (id: string) => void;
}) {
  const deleteSavedFolder = useFundingUiStore((s) => s.deleteSavedFolder);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: folderSortId(folder.id) });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2 py-1.5 text-sm",
        isDragging && "opacity-70",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          aria-label="Перетащить папку"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4 shrink-0" />
        </button>
        <span className="min-w-0 truncate font-medium">{folder.name}</span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Переименовать"
          onClick={() => onStartRename(folder.id)}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-destructive hover:text-destructive"
          aria-label="Удалить папку"
          onClick={() => {
            if (
              window.confirm(
                `Удалить папку «${folder.name}»? Токены останутся в «Без папки».`,
              )
            ) {
              deleteSavedFolder(folder.id);
            }
          }}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function SortableTokenRow({
  section,
  base,
  folderOptions,
  currentFolderId,
}: {
  section: string;
  base: string;
  folderOptions: { id: string; name: string }[];
  currentFolderId: string | null;
}) {
  const removeSavedToken = useFundingUiStore((s) => s.removeSavedToken);
  const id = tokenSortId(section, base);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-sm",
        isDragging && "opacity-70",
      )}
    >
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground"
        aria-label="Перетащить"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4 shrink-0" />
      </button>
      <span className="w-20 shrink-0 font-semibold tabular-nums tracking-wide">
        {base}
      </span>
      <span className="sr-only">Папка для {base}</span>
      <FolderPicker
        base={base}
        currentFolderId={currentFolderId}
        folderOptions={folderOptions}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="ml-auto text-muted-foreground hover:text-destructive"
        aria-label={`Убрать ${base} из сохранённых`}
        onClick={() => removeSavedToken(base)}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

function TokenBlock({
  title,
  section,
  folderId,
  bases,
  folderOptions,
}: {
  title: string;
  section: string;
  folderId: string | null;
  bases: string[];
  folderOptions: { id: string; name: string }[];
}) {
  const items = useMemo(
    () => bases.map((b) => tokenSortId(section, b)),
    [bases, section],
  );

  if (bases.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div
          className={cn(
            "flex flex-col gap-1.5",
            bases.length > 12 &&
              "max-h-[min(320px,42vh)] overflow-y-auto overscroll-contain pr-1",
          )}
        >
          {bases.map((base) => (
            <SortableTokenRow
              key={base}
              section={section}
              base={base}
              folderOptions={folderOptions}
              currentFolderId={folderId}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

export function SavedTokensWorkspace() {
  const savedFolders = useFundingUiStore((s) => s.savedFolders);
  const savedTokens = useFundingUiStore((s) => s.savedTokens);
  const addSavedFolder = useFundingUiStore((s) => s.addSavedFolder);
  const renameSavedFolder = useFundingUiStore((s) => s.renameSavedFolder);
  const reorderSavedFolders = useFundingUiStore((s) => s.reorderSavedFolders);
  const reorderSavedTokensInFolder = useFundingUiStore(
    (s) => s.reorderSavedTokensInFolder,
  );

  const [newFolderName, setNewFolderName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const foldersSorted = useMemo(
    () => [...savedFolders].sort((a, b) => a.order - b.order),
    [savedFolders],
  );

  const rootBases = useMemo(() => {
    return savedTokens
      .filter((t) => t.folderId === null)
      .sort((a, b) => a.order - b.order)
      .map((t) => t.base);
  }, [savedTokens]);

  const basesByFolder = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of savedFolders) {
      const list = savedTokens
        .filter((t) => t.folderId === f.id)
        .sort((a, b) => a.order - b.order)
        .map((t) => t.base);
      m.set(f.id, list);
    }
    return m;
  }, [savedTokens, savedFolders]);

  const folderOptions = useMemo(
    () => foldersSorted.map((f) => ({ id: f.id, name: f.name })),
    [foldersSorted],
  );

  const folderItems = useMemo(
    () => foldersSorted.map((f) => folderSortId(f.id)),
    [foldersSorted],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const active = parseDragId(String(event.active.id));
    const overId = event.over?.id;
    const over = overId ? parseDragId(String(overId)) : null;
    if (!active || !over) return;

    if (active.kind === "folder" && over.kind === "folder") {
      reorderSavedFolders(active.folderId, over.folderId);
      return;
    }
    if (active.kind === "token" && over.kind === "token") {
      if (active.section !== over.section) return;
      const folderId = active.section === "root" ? null : active.section;
      reorderSavedTokensInFolder(folderId, active.base, over.base);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="new-folder-name" className="text-xs">
            Новая папка
          </Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="new-folder-name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Название"
              className="max-w-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  addSavedFolder(newFolderName);
                  setNewFolderName("");
                }
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="gap-1"
              onClick={() => {
                addSavedFolder(newFolderName);
                setNewFolderName("");
              }}
            >
              <Plus className="size-4" />
              Папка
            </Button>
          </div>
        </div>
      </div>

      {renamingId && (
        <div className="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3">
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Переименовать</Label>
            <Input
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              className="w-56"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  renameSavedFolder(renamingId, renameDraft);
                  setRenamingId(null);
                }
              }}
            />
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              renameSavedFolder(renamingId, renameDraft);
              setRenamingId(null);
            }}
          >
            Сохранить
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRenamingId(null)}
          >
            Отмена
          </Button>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        {folderItems.length > 0 && (
          <div className="mb-6 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Папки (порядок)
            </h3>
            <SortableContext items={folderItems} strategy={verticalListSortingStrategy}>
              <div className="flex max-w-lg flex-col gap-1.5">
                {foldersSorted.map((f) => (
                  <SortableFolderRow
                    key={f.id}
                    folder={f}
                    onStartRename={(id) => {
                      const fo = savedFolders.find((x) => x.id === id);
                      setRenamingId(id);
                      setRenameDraft(fo?.name ?? "");
                    }}
                  />
                ))}
              </div>
            </SortableContext>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <TokenBlock
            title="Без папки"
            section="root"
            folderId={null}
            bases={rootBases}
            folderOptions={folderOptions}
          />
          {foldersSorted.map((f) => (
            <TokenBlock
              key={f.id}
              title={f.name}
              section={f.id}
              folderId={f.id}
              bases={basesByFolder.get(f.id) ?? []}
              folderOptions={folderOptions}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}
