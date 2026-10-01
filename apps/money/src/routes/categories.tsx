import { createSignal, For, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { api } from "../lib/api";
import { usePrivacyMode } from "../lib/privacy";
import { useCurrency } from "../lib/currency";
import { PageState } from "../components/PageState";
import { useCategoryForm, useCategoryGroupForm } from "../lib/forms/categories";
import { listenForMoneyDataChanged } from "../lib/data-events";
import * as Schema from "effect/Schema";
import type { CategoriesResponse } from "../domain/schemas-client";
import CategoryBadge from "../components/CategoryBadge";

interface CategoryGroup {
  id: string;
  name: string;
  isIncome: boolean;
  sortOrder: number;
  hidden: boolean;
}

type Category = Pick<
  CategoriesResponse["categories"][number],
  "id" | "name" | "groupId" | "isIncome" | "sortOrder" | "goalDef" | "hidden" | "icon"
> & { groupName: string | null };

type GoalType = "monthly" | "byDate" | "refill" | "periodic" | "percentage";
const GoalTypeSchema = Schema.Literals(["monthly", "byDate", "refill", "periodic", "percentage"]);

interface GoalConfig {
  type: GoalType;
  amount?: number;
  targetDate?: string;
  frequency?: string;
  percentage?: number;
}

const GoalConfigSchema = Schema.Struct({
  type: GoalTypeSchema,
  amount: Schema.optional(Schema.Number),
  targetDate: Schema.optional(Schema.String),
  frequency: Schema.optional(Schema.String),
  percentage: Schema.optional(Schema.Number),
});

interface GoalProgress {
  categoryId: string;
  goalType: GoalType;
  goalAmount: number;
  currentAmount: number;
  targetDate: string | null;
}

interface DeleteGroupPayload {
  id: string;
  transferToGroupId?: string;
}

interface DeleteCategoryPayload {
  id: string;
  transferToId?: string;
}

export default function CategoriesPage() {
  const privacyBlur = usePrivacyMode();
  const fmt = useCurrency();
  const [groups, setGroups] = createSignal<CategoryGroup[]>([]);
  const [categories, setCategories] = createSignal<Category[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  // Add group form
  const [showAddGroup, setShowAddGroup] = createSignal(false);

  // Add category form
  const [activeGroupId, setActiveGroupId] = createSignal<string | null>(null);

  // Goal editing
  const [editingGoalCatId, setEditingGoalCatId] = createSignal<string | null>(null);
  const [goalType, setGoalType] = createSignal<GoalType>("monthly");
  const [goalAmount, setGoalAmount] = createSignal("");
  const [goalTargetDate, setGoalTargetDate] = createSignal("");
  const [goalFrequency, setGoalFrequency] = createSignal("quarterly");
  const [goalPercentage, setGoalPercentage] = createSignal("10");
  const [goalProgress, setGoalProgress] = createSignal<GoalProgress[]>([]);

  const goalProgressMap = createMemo(() => {
    const map = new Map<string, GoalProgress>();
    for (const p of goalProgress()) {
      map.set(p.categoryId, p);
    }
    return map;
  });

  // Group rename
  const [renamingGroupId, setRenamingGroupId] = createSignal<string | null>(null);
  const [renameGroupName, setRenameGroupName] = createSignal("");

  // Group delete dialog
  const [deletingGroupId, setDeletingGroupId] = createSignal<string | null>(null);
  const [deleteTransferGroupId, setDeleteTransferGroupId] = createSignal<string>("");

  // Category delete with transfer
  const [deletingCatId, setDeletingCatId] = createSignal<string | null>(null);
  const [catTransferTargetId, setCatTransferTargetId] = createSignal<string>("");

  // Drag-and-drop reorder
  const [dragSourceId, setDragSourceId] = createSignal<string | null>(null);
  const [dragTargetId, setDragTargetId] = createSignal<string | null>(null);

  const {
    values: valuesGroup,
    errors: errorsGroup,
    setValues: setValuesGroup,
    validate: validateGroup,
    resetForm: resetFormGroup,
  } = useCategoryGroupForm();
  const {
    values: valuesCategory,
    errors: errorsCategory,
    setValues: setValuesCategory,
    validate: validateCategory,
    resetForm: resetFormCategory,
  } = useCategoryForm();

  createEffect(() => {
    void loadData();
  });

  onMount(() => {
    onCleanup(listenForMoneyDataChanged(loadData));
  });

  async function loadData() {
    setError(null);
    try {
      const [categoriesData, groupsData, goalProgressData] = await Promise.all([
        api.categories(),
        api.categoryGroups(),
        api.goalProgress(),
      ]);
      const cats: Category[] = (categoriesData.categories ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon ?? null,
        groupId: c.groupId ?? null,
        groupName: c.group_name ?? null,
        isIncome: Boolean(c.isIncome),
        sortOrder: c.sortOrder ?? 0,
        goalDef: c.goalDef ?? null,
        hidden: Boolean(c.hidden),
      }));
      setCategories(cats);

      setGroups(
        (groupsData.groups ?? []).map((g) => ({
          id: g.id,
          name: g.name,
          isIncome: Boolean(g.isIncome),
          sortOrder: g.sortOrder ?? 0,
          hidden: Boolean(g.hidden),
        })),
      );

      setGoalProgress(
        goalProgressData.progress.map((p) => ({
          categoryId: p.categoryId,
          goalType: Schema.decodeUnknownSync(GoalTypeSchema)(p.goalType),
          goalAmount: p.goalAmount,
          currentAmount: p.currentAmount,
          targetDate: p.targetDate,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load categories");
    } finally {
      setLoading(false);
    }
  }

  function handleAddGroup(e: Event) {
    e.preventDefault();
    if (!validateGroup()) return;
    const name = valuesGroup.name.trim();
    setShowAddGroup(false);
    void dispatch(
      "create_category_group",
      { name, isIncome: valuesGroup.isIncome },
      {
        undoInfo: {
          label: "Create group",
          inverse: (data) => ({
            commandType: "delete_category_group",
            payload: { id: requireCommandId(data) },
          }),
        },
      },
    ).promise.then(loadData);
    resetFormGroup();
  }

  function handleAddCategory(e: Event, groupId: string) {
    e.preventDefault();
    if (!validateCategory()) return;
    const name = valuesCategory.name.trim();
    setActiveGroupId(null);
    void dispatch(
      "create_category",
      { name, groupId },
      {
        undoInfo: {
          label: "Create category",
          inverse: (data) => ({
            commandType: "delete_category",
            payload: { id: requireCommandId(data) },
          }),
        },
      },
    ).promise.then(loadData);
    resetFormCategory();
  }

  function startRenameGroup(group: CategoryGroup) {
    setRenamingGroupId(group.id);
    setRenameGroupName(group.name);
  }

  function handleRenameGroup(groupId: string) {
    const name = renameGroupName().trim();
    if (!name) {
      cancelRenameGroup();
      return;
    }
    const group = groups().find((g) => g.id === groupId);
    const oldName = group?.name ?? "";
    setRenamingGroupId(null);
    void dispatch(
      "update_category_group",
      { id: groupId, name },
      {
        undoInfo: {
          label: "Rename group",
          inverse: {
            commandType: "update_category_group",
            payload: { id: groupId, name: oldName },
          },
        },
      },
    ).promise.then(loadData);
  }

  function cancelRenameGroup() {
    setRenamingGroupId(null);
    setRenameGroupName("");
  }

  function handleToggleGroupHidden(group: CategoryGroup) {
    void dispatch(
      "update_category_group",
      { id: group.id, hidden: !group.hidden },
      {
        undoInfo: {
          label: group.hidden ? "Unhide group" : "Hide group",
          inverse: {
            commandType: "update_category_group",
            payload: { id: group.id, hidden: group.hidden },
          },
        },
      },
    ).promise.then(loadData);
    setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, hidden: !g.hidden } : g)));
  }

  function handleToggleGroupIsIncome(group: CategoryGroup) {
    void dispatch(
      "update_category_group",
      {
        id: group.id,
        isIncome: !group.isIncome,
      },
      {
        undoInfo: {
          label: group.isIncome ? "Set as expense" : "Set as income",
          inverse: {
            commandType: "update_category_group",
            payload: { id: group.id, isIncome: group.isIncome },
          },
        },
      },
    ).promise.then(loadData);
    setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, isIncome: !g.isIncome } : g)));
  }

  function confirmDeleteGroup(groupId: string) {
    setDeletingGroupId(groupId);
    setDeleteTransferGroupId("");
  }

  function handleDeleteGroup() {
    const groupId = deletingGroupId();
    if (!groupId) return;
    const group = groups().find((g) => g.id === groupId);
    const payload: DeleteGroupPayload = { id: groupId };
    if (deleteTransferGroupId()) {
      payload.transferToGroupId = deleteTransferGroupId();
    }
    setDeletingGroupId(null);
    void dispatch("delete_category_group", payload, {
      undoInfo: {
        label: "Delete group",
        inverse: {
          commandType: "create_category_group",
          payload: { name: group?.name ?? "", isIncome: group?.isIncome ?? false },
        },
      },
    }).promise.then(loadData);
    setGroups((prev) => prev.filter((g) => g.id !== groupId));
  }

  function handleToggleCategoryHidden(cat: Category) {
    void dispatch(
      "update_category",
      { id: cat.id, hidden: !cat.hidden },
      {
        undoInfo: {
          label: cat.hidden ? "Unhide category" : "Hide category",
          inverse: { commandType: "update_category", payload: { id: cat.id, hidden: cat.hidden } },
        },
      },
    ).promise.then(loadData);
    setCategories((prev) => prev.map((c) => (c.id === cat.id ? { ...c, hidden: !c.hidden } : c)));
  }

  function confirmDeleteCategory(catId: string) {
    setDeletingCatId(catId);
    setCatTransferTargetId("");
  }

  function handleDeleteCategory() {
    const catId = deletingCatId();
    if (!catId) return;
    const cat = categories().find((c) => c.id === catId);
    const payload: DeleteCategoryPayload = { id: catId };
    if (catTransferTargetId()) {
      payload.transferToId = catTransferTargetId();
    }
    setDeletingCatId(null);
    dispatch("delete_category", payload, {
      undoInfo: {
        label: "Delete category",
        inverse: {
          commandType: "create_category",
          payload: {
            name: cat?.name ?? "",
            groupId: cat?.groupId ?? null,
            icon: cat?.icon ?? null,
          },
        },
      },
    });
    setCategories((prev) => prev.filter((c) => c.id !== catId));
  }

  function startEditGoal(cat: Category) {
    const goal = parseGoal(cat.goalDef);
    setGoalType(goal?.type ?? "monthly");
    setGoalAmount(goal?.amount ? fmt().formatCentsInput(goal.amount) : "");
    setGoalTargetDate(goal?.targetDate ?? "");
    setGoalFrequency(goal?.frequency ?? "quarterly");
    setGoalPercentage(goal?.percentage ? String(goal.percentage) : "10");
    setEditingGoalCatId(cat.id);
  }

  function cancelEditGoal() {
    setEditingGoalCatId(null);
    setGoalAmount("");
    setGoalTargetDate("");
    setGoalFrequency("quarterly");
    setGoalPercentage("10");
  }

  function saveGoal(catId: string) {
    const cat = categories().find((c) => c.id === catId);
    const oldGoalDef = cat?.goalDef ?? null;
    if (goalType() === "percentage") {
      const pct = parseFloat(goalPercentage() || "0");
      if (pct <= 0 || pct > 100) {
        dispatch(
          "update_category",
          { id: catId, goalDef: null },
          {
            undoInfo: {
              label: "Remove goal",
              inverse: {
                commandType: "update_category",
                payload: { id: catId, goalDef: oldGoalDef },
              },
            },
          },
        );
      } else {
        dispatch(
          "update_category",
          {
            id: catId,
            goalDef: JSON.stringify({ type: "percentage", percentage: pct }),
          },
          {
            undoInfo: {
              label: "Set goal",
              inverse: {
                commandType: "update_category",
                payload: { id: catId, goalDef: oldGoalDef },
              },
            },
          },
        );
      }
      setCategories((prev) =>
        prev.map((c) =>
          c.id === catId
            ? {
                ...c,
                goalDef: pct > 0 ? JSON.stringify({ type: "percentage", percentage: pct }) : null,
              }
            : c,
        ),
      );
    } else {
      const amount = fmt().parseInput(goalAmount() || "0");
      if (!Number.isSafeInteger(amount)) {
        setError("Enter a valid target amount.");
        return;
      }
      if (amount <= 0) {
        dispatch(
          "update_category",
          { id: catId, goalDef: null },
          {
            undoInfo: {
              label: "Remove goal",
              inverse: {
                commandType: "update_category",
                payload: { id: catId, goalDef: oldGoalDef },
              },
            },
          },
        );
      } else {
        const goal = buildGoalJson();
        dispatch(
          "update_category",
          { id: catId, goalDef: JSON.stringify(goal) },
          {
            undoInfo: {
              label: "Set goal",
              inverse: {
                commandType: "update_category",
                payload: { id: catId, goalDef: oldGoalDef },
              },
            },
          },
        );
      }
      setCategories((prev) =>
        prev.map((c) =>
          c.id === catId
            ? {
                ...c,
                goalDef: amount > 0 ? JSON.stringify(buildGoalJson()) : null,
              }
            : c,
        ),
      );
    }
    cancelEditGoal();
  }

  function buildGoalJson(): GoalConfig {
    const t = goalType();
    const amt = fmt().parseInput(goalAmount() || "0");
    const goal: GoalConfig = { type: t, amount: amt };
    if ((t === "byDate" || t === "refill") && goalTargetDate()) {
      goal.targetDate = goalTargetDate();
    }
    if (t === "periodic") {
      goal.frequency = goalFrequency();
    }
    return goal;
  }

  function parseGoal(goalDef: string | null): GoalConfig | null {
    if (!goalDef) return null;
    try {
      return Schema.decodeUnknownSync(GoalConfigSchema)(JSON.parse(goalDef));
    } catch {
      console.warn("[categories] failed to parse goal definition");
      return null;
    }
  }

  function formatGoal(goalDef: string | null): string {
    const goal = parseGoal(goalDef);
    if (!goal) return "";
    const amt = goal.amount ? fmt().formatCents(goal.amount) : "";
    if (goal.type === "byDate" && goal.targetDate) {
      return `Save ${amt} by ${goal.targetDate}`;
    }
    if (goal.type === "refill") {
      const byDate = goal.targetDate ? ` by ${goal.targetDate}` : "";
      return `Refill to ${amt}${byDate}`;
    }
    if (goal.type === "periodic") {
      const freq = goal.frequency ?? "quarterly";
      return `Budget ${amt} ${freq}`;
    }
    if (goal.type === "percentage") {
      const pct = goal.percentage ?? 0;
      return `Budget ${pct}% of income`;
    }
    return `Set ${amt} monthly`;
  }

  const grouped = () => {
    const map = new Map<string | null, Category[]>();
    for (const cat of categories()) {
      const list = map.get(cat.groupId) ?? [];
      list.push(cat);
      map.set(cat.groupId, list);
    }
    for (const group of groups()) {
      if (!map.has(group.id)) map.set(group.id, []);
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      const groupA = groups().find((g) => g.id === a);
      const groupB = groups().find((g) => g.id === b);
      return (groupA?.sortOrder ?? 0) - (groupB?.sortOrder ?? 0);
    });
  };

  const visibleGroups = () =>
    grouped().filter(([groupId]) => {
      const group = groups().find((g) => g.id === groupId);
      return !group?.hidden;
    });

  const hiddenGroups = () =>
    grouped().filter(([groupId]) => {
      const group = groups().find((g) => g.id === groupId);
      return group?.hidden;
    });

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">Categories</h1>
        <button class="btn btn-primary btn-sm" onClick={() => setShowAddGroup(true)}>
          + Add Group
        </button>
      </div>

      <Show when={showAddGroup()}>
        <div class="section">
          <form onSubmit={handleAddGroup} class="settings-section">
            <div class="form-row">
              <div class="form-group" style={{ flex: "1" }}>
                <label>Group Name</label>
                <input
                  type="text"
                  placeholder="e.g. Fixed Expenses"
                  value={valuesGroup.name}
                  onInput={(e) => setValuesGroup("name", e.currentTarget.value)}
                  class={errorsGroup.name ? "input-error" : ""}
                />
                {errorsGroup.name && <span class="error-message">{errorsGroup.name.message}</span>}
              </div>
              <div class="form-check" style={{ "margin-top": "24px" }}>
                <input
                  type="checkbox"
                  id="income-group"
                  checked={valuesGroup.isIncome}
                  onChange={(e) => setValuesGroup("isIncome", e.currentTarget.checked)}
                />
                <label for="income-group">Income group</label>
              </div>
            </div>
            <div class="form-actions">
              <button type="button" class="btn btn-ghost" onClick={() => setShowAddGroup(false)}>
                Cancel
              </button>
              <button type="submit" class="btn btn-primary">
                Create Group
              </button>
            </div>
          </form>
        </div>
      </Show>

      <PageState
        loading={loading()}
        error={error()}
        onRetry={loadData}
        loadingMessage="Loading categories..."
      >
        <Show
          when={groups().length > 0 || categories().length > 0}
          fallback={
            <div class="empty-state">
              <p>No categories yet.</p>
              <p>Create a group above, then add categories to it.</p>
            </div>
          }
        >
          <For each={visibleGroups()}>
            {([groupId, cats]) => {
              const group = groups().find((g) => g.id === groupId);
              return (
                <div class={`section${group?.isIncome ? " section-income" : ""}`}>
                  <div
                    class="budget-group-title"
                    style={{ display: "flex", "flex-direction": "column", gap: "4px" }}
                  >
                    <div
                      style={{
                        display: "flex",
                        "justify-content": "space-between",
                        "align-items": "center",
                        width: "100%",
                      }}
                    >
                      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                        <Show
                          when={renamingGroupId() === group?.id}
                          fallback={
                            <span
                              style={{ cursor: "pointer" }}
                              onClick={() => group && startRenameGroup(group)}
                              title="Rename group"
                            >
                              <span
                                class={`group-type-indicator ${group?.isIncome ? "group-type-income" : "group-type-expense"}`}
                              />
                              {group?.name ?? "Uncategorized"}
                              {group?.isIncome ? (
                                <span class="goal-badge" style={{ "margin-left": "8px" }}>
                                  Income
                                </span>
                              ) : null}
                            </span>
                          }
                        >
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (group) handleRenameGroup(group.id);
                            }}
                            style={{ display: "inline-flex", gap: "4px" }}
                          >
                            <input
                              type="text"
                              value={renameGroupName()}
                              onInput={(e) => setRenameGroupName(e.currentTarget.value)}
                              autofocus
                              onBlur={() => {
                                if (group) handleRenameGroup(group.id);
                              }}
                            />
                          </form>
                        </Show>
                      </div>
                      <div style={{ display: "flex", gap: "4px" }}>
                        <button
                          class="btn btn-ghost btn-xs"
                          onClick={() => group && handleToggleGroupIsIncome(group)}
                          title={group?.isIncome ? "Switch to expense" : "Switch to income"}
                        >
                          {group?.isIncome ? "💰" : "💳"}
                        </button>
                        <button
                          class="btn btn-ghost btn-xs"
                          onClick={() => group && handleToggleGroupHidden(group)}
                          title={group?.hidden ? "Show group" : "Hide group"}
                        >
                          {group?.hidden ? "👁️" : "👁️‍🗨️"}
                        </button>
                        <button
                          class="btn btn-ghost btn-xs"
                          onClick={() =>
                            setActiveGroupId(activeGroupId() === groupId ? null : groupId)
                          }
                        >
                          {activeGroupId() === groupId ? "Cancel" : "+ Category"}
                        </button>
                        <Show when={group}>
                          <button
                            class="btn btn-icon btn-ghost btn-xs"
                            onClick={() => group && confirmDeleteGroup(group.id)}
                            title="Delete group"
                          >
                            🗑️
                          </button>
                        </Show>
                      </div>
                    </div>
                  </div>

                  <Show when={deletingGroupId() === group?.id}>
                    <div class="goal-editor">
                      <div class="form-row">
                        <select
                          value={deleteTransferGroupId()}
                          onChange={(e) => setDeleteTransferGroupId(e.currentTarget.value)}
                        >
                          <option value="">Delete categories inside too</option>
                          <For each={groups().filter((g) => g.id !== groupId && !g.hidden)}>
                            {(g) => <option value={g.id}>Move categories to {g.name}</option>}
                          </For>
                        </select>
                        <button class="btn btn-primary btn-sm" onClick={handleDeleteGroup}>
                          Confirm Delete
                        </button>
                        <button
                          class="btn btn-ghost btn-sm"
                          onClick={() => setDeletingGroupId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </Show>

                  <Show when={activeGroupId() === groupId}>
                    <form
                      onSubmit={(event) => {
                        if (groupId) handleAddCategory(event, groupId);
                      }}
                      class="settings-section"
                      style={{ padding: "12px 16px", "margin-bottom": "8px" }}
                    >
                      <div class="form-row">
                        <div class="form-group" style={{ flex: "1", "margin-bottom": 0 }}>
                          <input
                            type="text"
                            placeholder="Category name"
                            value={valuesCategory.name}
                            onInput={(e) => setValuesCategory("name", e.currentTarget.value)}
                            class={errorsCategory.name ? "input-error" : ""}
                          />
                          {errorsCategory.name && (
                            <span class="error-message">{errorsCategory.name.message}</span>
                          )}
                        </div>
                        <button type="submit" class="btn btn-primary btn-sm">
                          Add
                        </button>
                      </div>
                    </form>
                  </Show>

                  <div class="category-list">
                    <For each={cats}>
                      {(cat, _idx) => {
                        const isDragging = () => dragSourceId() === cat.id;
                        const isDragTarget = () => dragTargetId() === cat.id;

                        function handleDragStart(e: DragEvent) {
                          setDragSourceId(cat.id);
                          setDragTargetId(null);
                          if (e.dataTransfer) {
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", cat.id);
                          }
                        }

                        function handleDragOver(e: DragEvent) {
                          if (dragSourceId() && dragSourceId() !== cat.id) {
                            e.preventDefault();
                            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                            setDragTargetId(cat.id);
                          }
                        }

                        function handleDragLeave() {
                          if (dragTargetId() === cat.id) {
                            setDragTargetId(null);
                          }
                        }

                        function handleDrop(e: DragEvent) {
                          e.preventDefault();
                          const sourceId = dragSourceId();
                          const targetId = dragTargetId();
                          if (!sourceId || !targetId || sourceId === targetId) {
                            setDragSourceId(null);
                            setDragTargetId(null);
                            return;
                          }

                          const currentCats = categories();
                          const groupId = cat.groupId;
                          const groupCats = currentCats
                            .filter((c) => c.groupId === groupId)
                            .sort((a, b) => a.sortOrder - b.sortOrder);

                          const sourceIdx = groupCats.findIndex((c) => c.id === sourceId);
                          const targetIdx = groupCats.findIndex((c) => c.id === targetId);
                          if (sourceIdx === -1 || targetIdx === -1) {
                            setDragSourceId(null);
                            setDragTargetId(null);
                            return;
                          }

                          const reordered = [...groupCats];
                          const [moved] = reordered.splice(sourceIdx, 1);
                          reordered.splice(targetIdx, 0, moved);

                          dispatch("reorder_categories", { ids: reordered.map((c) => c.id) });
                          setCategories((prev) => {
                            const updated = prev.filter((c) => c.groupId !== groupId);
                            const withNewOrder = reordered.map((c, i) => ({
                              ...c,
                              sortOrder: i,
                            }));
                            return [...updated, ...withNewOrder].sort(
                              (a, b) => a.sortOrder - b.sortOrder,
                            );
                          });

                          setDragSourceId(null);
                          setDragTargetId(null);
                        }

                        function handleDragEnd() {
                          setDragSourceId(null);
                          setDragTargetId(null);
                        }

                        return (
                          <>
                            <div
                              class="payee-row"
                              classList={{
                                dragging: isDragging(),
                                "drag-over": isDragTarget(),
                              }}
                              style={{ opacity: cat.hidden ? 0.5 : 1 }}
                              draggable={true}
                              onDragStart={handleDragStart}
                              onDragOver={handleDragOver}
                              onDragLeave={handleDragLeave}
                              onDrop={handleDrop}
                              onDragEnd={handleDragEnd}
                            >
                              <span class="drag-handle" title="Drag to reorder">
                                ⠿
                              </span>
                              <div
                                style={{
                                  display: "flex",
                                  "flex-direction": "column",
                                  gap: "2px",
                                }}
                              >
                                <div
                                  style={{ display: "flex", "align-items": "center", gap: "6px" }}
                                >
                                  <CategoryBadge name={cat.name} icon={cat.icon} small />
                                  <span class="payee-name">{cat.name}</span>
                                  <Show when={cat.hidden}>
                                    <span class="goal-badge" style={{ "font-size": "11px" }}>
                                      Hidden
                                    </span>
                                  </Show>
                                </div>
                                <Show when={cat.goalDef}>
                                  <span class="goal-badge">{formatGoal(cat.goalDef)}</span>
                                  <Show when={goalProgressMap().get(cat.id)}>
                                    {(progress) => {
                                      const p = progress();
                                      const pct =
                                        p.goalAmount > 0
                                          ? Math.min(
                                              Math.round(
                                                (Math.abs(p.currentAmount) / p.goalAmount) * 100,
                                              ),
                                              100,
                                            )
                                          : 0;
                                      const status =
                                        pct >= 100 ? "funded" : pct >= 50 ? "partial" : "under";
                                      return (
                                        <div class="goal-progress">
                                          <div class="goal-progress-bar">
                                            <div
                                              class={`goal-progress-fill goal-progress-${status}`}
                                              style={{ width: `${pct}%` }}
                                            />
                                          </div>
                                          <span
                                            class={`goal-progress-label goal-progress-${status} ${privacyBlur().blurClass()}`}
                                          >
                                            {p.goalType === "monthly"
                                              ? `${fmt().formatCents(Math.abs(p.currentAmount))} / ${fmt().formatCents(p.goalAmount)}`
                                              : p.goalType === "percentage"
                                                ? `${(p.currentAmount / 100).toFixed(2)}% / ${p.goalAmount}%`
                                                : `${fmt().formatCents(Math.abs(p.currentAmount))} / ${fmt().formatCents(p.goalAmount)}`}
                                            <Show when={p.goalType === "byDate" && p.targetDate}>
                                              {" "}
                                              by {p.targetDate}
                                            </Show>
                                            <Show when={p.goalType === "refill"}>
                                              {" "}
                                              <Show when={p.targetDate}>by {p.targetDate}</Show>
                                            </Show>
                                          </span>
                                        </div>
                                      );
                                    }}
                                  </Show>
                                </Show>
                              </div>
                              <div style={{ display: "flex", gap: "4px" }}>
                                <button
                                  class="btn btn-ghost btn-xs"
                                  onClick={() => handleToggleCategoryHidden(cat)}
                                  title={cat.hidden ? "Unhide" : "Hide"}
                                >
                                  {cat.hidden ? "👁️" : "👁️‍🗨️"}
                                </button>
                                <button
                                  class="btn btn-ghost btn-xs"
                                  onClick={() => startEditGoal(cat)}
                                  title="Set goal"
                                >
                                  🎯
                                </button>
                                <button
                                  class="btn btn-icon btn-ghost btn-xs"
                                  onClick={() => confirmDeleteCategory(cat.id)}
                                >
                                  🗑️
                                </button>
                              </div>
                            </div>
                            <Show when={deletingCatId() === cat.id}>
                              <div class="goal-editor">
                                <div class="form-row">
                                  <select
                                    value={catTransferTargetId()}
                                    onChange={(e) => setCatTransferTargetId(e.currentTarget.value)}
                                  >
                                    <option value="">Delete permanently</option>
                                    <For
                                      each={categories().filter(
                                        (c) => c.id !== cat.id && !c.hidden,
                                      )}
                                    >
                                      {(c) => <option value={c.id}>Transfer to {c.name}</option>}
                                    </For>
                                  </select>
                                  <button
                                    class="btn btn-primary btn-sm"
                                    onClick={handleDeleteCategory}
                                  >
                                    Confirm Delete
                                  </button>
                                  <button
                                    class="btn btn-ghost btn-sm"
                                    onClick={() => setDeletingCatId(null)}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            </Show>
                            <Show when={editingGoalCatId() === cat.id}>
                              <div class="goal-editor">
                                <div class="form-row">
                                  <select
                                    value={goalType()}
                                    onChange={(e) =>
                                      setGoalType(
                                        Schema.decodeUnknownSync(GoalTypeSchema)(
                                          e.currentTarget.value,
                                        ),
                                      )
                                    }
                                  >
                                    <option value="monthly">Monthly amount</option>
                                    <option value="byDate">Save up by date</option>
                                    <option value="refill">Refill target balance</option>
                                    <option value="periodic">Periodic allocation</option>
                                    <option value="percentage">% of income</option>
                                  </select>
                                  <Show when={goalType() !== "percentage"}>
                                    <input
                                      type="text"
                                      inputmode={fmt().inputMode}
                                      placeholder="Amount"
                                      value={goalAmount()}
                                      onInput={(e) => setGoalAmount(e.currentTarget.value)}
                                    />
                                  </Show>
                                  <Show when={goalType() === "percentage"}>
                                    <input
                                      type="number"
                                      step="0.1"
                                      min="0.1"
                                      max="100"
                                      placeholder="Percent"
                                      value={goalPercentage()}
                                      onInput={(e) => setGoalPercentage(e.currentTarget.value)}
                                    />
                                    <span
                                      style={{
                                        "align-self": "center",
                                        color: "var(--text-muted)",
                                        "font-size": "0.85rem",
                                      }}
                                    >
                                      %
                                    </span>
                                  </Show>
                                  <Show when={goalType() === "byDate" || goalType() === "refill"}>
                                    <input
                                      type="month"
                                      value={goalTargetDate()}
                                      onInput={(e) => setGoalTargetDate(e.currentTarget.value)}
                                    />
                                  </Show>
                                  <Show when={goalType() === "periodic"}>
                                    <select
                                      value={goalFrequency()}
                                      onChange={(e) => setGoalFrequency(e.currentTarget.value)}
                                    >
                                      <option value="quarterly">Every 3 months</option>
                                      <option value="biannual">Every 6 months</option>
                                      <option value="yearly">Every 12 months</option>
                                    </select>
                                  </Show>
                                  <button
                                    class="btn btn-primary btn-sm"
                                    onClick={() => saveGoal(cat.id)}
                                  >
                                    Save
                                  </button>
                                  <button class="btn btn-ghost btn-sm" onClick={cancelEditGoal}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            </Show>
                          </>
                        );
                      }}
                    </For>
                  </div>
                </div>
              );
            }}
          </For>

          <Show when={hiddenGroups().length > 0}>
            <div class="section">
              <div class="budget-group-title">
                <span style={{ opacity: 0.5 }}>Hidden Groups ({hiddenGroups().length})</span>
              </div>
              <div class="category-list">
                <For each={hiddenGroups()}>
                  {([groupId]) => {
                    const group = groups().find((g) => g.id === groupId);
                    if (!group) return null;
                    return (
                      <div class="payee-row" style={{ opacity: 0.5 }}>
                        <span class="payee-name">{group.name}</span>
                        <button
                          class="btn btn-ghost btn-xs"
                          onClick={() => handleToggleGroupHidden(group)}
                          title="Unhide group"
                        >
                          👁️
                        </button>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          </Show>
        </Show>
      </PageState>
    </div>
  );
}
