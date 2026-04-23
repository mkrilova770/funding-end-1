"use client";

import { RotateCcw, Trash2 } from "lucide-react";
import { useFundingUiStore } from "@/features/funding-table/funding-ui-store";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function TrashBinDialog() {
  const open = useFundingUiStore((s) => s.trashOpen);
  const setOpen = useFundingUiStore((s) => s.setTrashOpen);
  const hiddenTokens = useFundingUiStore((s) => s.hiddenTokens);
  const restoreToken = useFundingUiStore((s) => s.restoreToken);
  const restoreAll = useFundingUiStore((s) => s.restoreAllTokens);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-4" />
            Корзина
          </DialogTitle>
          <DialogDescription>
            {hiddenTokens.length === 0
              ? "Корзина пуста"
              : `Скрыто токенов: ${hiddenTokens.length}`}
          </DialogDescription>
        </DialogHeader>

        {hiddenTokens.length > 0 && (
          <div className="max-h-72 overflow-y-auto rounded-lg border">
            <ul className="divide-y">
              {hiddenTokens.map((base) => (
                <li
                  key={base}
                  className="flex items-center justify-between px-3 py-2 text-sm"
                >
                  <span className="font-semibold tracking-wide">{base}</span>
                  <button
                    type="button"
                    onClick={() => restoreToken(base)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100 dark:text-sky-400 dark:hover:bg-sky-950/50"
                  >
                    <RotateCcw className="size-3" />
                    Вернуть
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {hiddenTokens.length > 0 && (
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                restoreAll();
                setOpen(false);
              }}
            >
              <RotateCcw className="mr-1.5 size-3.5" />
              Вернуть все
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
