import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { api } from "../lib/api";
import { loadRequest, requestValue, requestError } from "../lib/request-state";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { emitMoneyDataChanged, listenForMoneyDataChanged } from "../lib/data-events";
import type { CommandPayload } from "../lib/api";
import type { CategoryDefinition } from "../lib/budget-view";
import type { CategoryGroupsResponse } from "../domain/schemas-client";
import MoneyDialog from "../components/MoneyDialog";
import MoneyIcon from "../components/MoneyIcon";
import CategoryBadge from "../components/CategoryBadge";
import CategoryEditor from "../components/CategoryEditor";
import { PageState } from "../components/PageState";
type Group = CategoryGroupsResponse["groups"][number];
type GroupForm = { mode: "create" } | { mode: "edit"; group: Group };
type Deletion =
  | { kind: "category"; category: CategoryDefinition }
  | { kind: "group"; group: Group };
export default function CategoriesPage() {
  const [params, setParams] = useSearchParams<{ edit?: string; new?: string; group?: string }>();
  const [query, setQuery] = createSignal("");
  const [reordering, setReordering] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [groupForm, setGroupForm] = createSignal<GroupForm | null>(null);
  const [groupName, setGroupName] = createSignal("");
  const [incomeGroup, setIncomeGroup] = createSignal(false);
  const [deleting, setDeleting] = createSignal<Deletion | null>(null);
  const [destination, setDestination] = createSignal("");
  const [result, { refetch }] = createResource(() =>
    loadRequest(async () => {
      const [categories, groups] = await Promise.all([api.categories(), api.categoryGroups()]);
      return { categories: categories.categories, groups: groups.groups };
    }),
  );
  const data = () => requestValue(result());
  const orderedGroups = createMemo(() =>
    [...(data()?.groups ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    ),
  );
  const orderedCategories = createMemo(() =>
    [...(data()?.categories ?? [])].sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    ),
  );
  const editing = () => orderedCategories().find((row) => row.id === params.edit);
  const matches = (row: CategoryDefinition) =>
    row.name.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase());
  const visibleRows = (id: string | null, isIncome = false) =>
    orderedCategories().filter(
      (row) =>
        row.groupId === id &&
        (id !== null || row.isIncome === isIncome) &&
        !row.hidden &&
        matches(row),
    );
  const hiddenRows = createMemo(() =>
    orderedCategories().filter(
      (row) =>
        row.hidden || orderedGroups().some((group) => group.id === row.groupId && group.hidden),
    ),
  );
  onMount(() =>
    onCleanup(
      listenForMoneyDataChanged(() => {
        if (!busy()) void refetch();
      }),
    ),
  );
  async function mutate(
    commandType: string,
    payload: CommandPayload,
    options?: Parameters<typeof dispatch>[2],
  ) {
    if (busy()) return false;
    setBusy(true);
    setError(null);
    try {
      await dispatch(commandType, payload, options).promise;
      await refetch();
      emitMoneyDataChanged();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save change");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function toggleHidden(category: CategoryDefinition) {
    await mutate(
      "update_category",
      { id: category.id, hidden: !category.hidden },
      {
        undoInfo: {
          label: category.hidden ? "Show category" : "Hide category",
          inverse: {
            commandType: "update_category",
            payload: { id: category.id, hidden: category.hidden },
          },
        },
      },
    );
  }
  function startGroup(group?: Group) {
    setError(null);
    setGroupName(group?.name ?? "");
    setIncomeGroup(group?.isIncome ?? false);
    setGroupForm(group ? { mode: "edit", group } : { mode: "create" });
  }
  async function saveGroup(event: SubmitEvent) {
    event.preventDefault();
    const form = groupForm();
    if (!form || !groupName().trim()) return;
    const name = groupName().trim();
    const saved =
      form.mode === "create"
        ? await mutate(
            "create_category_group",
            { name, isIncome: incomeGroup() },
            {
              undoInfo: {
                label: "Add group",
                inverse: (data) => ({
                  commandType: "delete_category_group",
                  payload: { id: requireCommandId(data) },
                }),
              },
            },
          )
        : await mutate(
            "update_category_group",
            { id: form.group.id, name },
            {
              undoInfo: {
                label: "Rename group",
                inverse: {
                  commandType: "update_category_group",
                  payload: { id: form.group.id, name: form.group.name },
                },
              },
            },
          );
    if (saved) setGroupForm(null);
  }
  function confirmDelete(value: Deletion) {
    setError(null);
    setDestination("");
    setDeleting(value);
  }
  async function remove(event: SubmitEvent) {
    event.preventDefault();
    const value = deleting();
    if (!value) return;
    const saved =
      value.kind === "category"
        ? await mutate("delete_category", {
            id: value.category.id,
            transferToId: destination() || null,
          })
        : await mutate("delete_category_group", {
            id: value.group.id,
            transferToGroupId: destination() || null,
          });
    if (saved) setDeleting(null);
  }
  async function moveCategory(category: CategoryDefinition, direction: number) {
    const rows = orderedCategories().filter(
      (row) =>
        row.groupId === category.groupId &&
        row.isIncome === category.isIncome &&
        row.hidden === category.hidden,
    );
    const old = rows.map((row) => row.id);
    const index = old.indexOf(category.id);
    const next = [...old];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await mutate(
      "reorder_categories",
      { ids: next },
      {
        undoInfo: {
          label: "Reorder categories",
          inverse: { commandType: "reorder_categories", payload: { ids: old } },
        },
      },
    );
  }
  async function moveGroup(group: Group, direction: number) {
    const old = orderedGroups().map((row) => row.id);
    const index = old.indexOf(group.id);
    const next = [...old];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await mutate(
      "reorder_category_groups",
      { ids: next },
      {
        undoInfo: {
          label: "Reorder groups",
          inverse: { commandType: "reorder_category_groups", payload: { ids: old } },
        },
      },
    );
  }
  function placeMenu(event: Event) {
    const menu = event.currentTarget;
    if (menu instanceof HTMLDetailsElement && menu.open)
      menu.dataset.direction =
        innerHeight - menu.getBoundingClientRect().bottom < 260 ? "up" : "down";
  }
  function closeMenu(event: MouseEvent) {
    if (event.currentTarget instanceof HTMLElement)
      event.currentTarget.closest("details")?.removeAttribute("open");
  }
  function CategoryRow(props: { category: CategoryDefinition }) {
    const siblings = () =>
      orderedCategories().filter(
        (row) =>
          row.groupId === props.category.groupId &&
          row.isIncome === props.category.isIncome &&
          row.hidden === props.category.hidden,
      );
    return (
      <div class="category-manager-row">
        <button
          class="category-manager-open"
          disabled={busy() || reordering()}
          onClick={() => setParams({ edit: props.category.id })}
        >
          <CategoryBadge name={props.category.name} icon={props.category.icon} />
          <strong>{props.category.name}</strong>
        </button>
        <Show
          when={reordering()}
          fallback={
            <details class="entity-menu" onToggle={placeMenu}>
              <summary aria-label={`Actions for ${props.category.name}`}>
                <MoneyIcon name="more" size={18} />
              </summary>
              <div class="entity-menu-popover">
                <button
                  disabled={busy()}
                  onClick={(event) => {
                    closeMenu(event);
                    setParams({ edit: props.category.id });
                  }}
                >
                  Edit
                </button>
                <button
                  disabled={busy()}
                  onClick={(event) => {
                    closeMenu(event);
                    void toggleHidden(props.category);
                  }}
                >
                  {props.category.hidden ? "Show" : "Hide"}
                </button>
                <button
                  class="text-danger"
                  disabled={busy()}
                  onClick={(event) => {
                    closeMenu(event);
                    confirmDelete({ kind: "category", category: props.category });
                  }}
                >
                  Delete
                </button>
              </div>
            </details>
          }
        >
          <div class="reorder-controls">
            <button
              class="btn btn-icon btn-ghost"
              aria-label={`Move ${props.category.name} up`}
              disabled={busy() || siblings()[0]?.id === props.category.id}
              onClick={() => void moveCategory(props.category, -1)}
            >
              <span aria-hidden="true">↑</span>
            </button>
            <button
              class="btn btn-icon btn-ghost"
              aria-label={`Move ${props.category.name} down`}
              disabled={busy() || siblings().at(-1)?.id === props.category.id}
              onClick={() => void moveCategory(props.category, 1)}
            >
              <span aria-hidden="true">↓</span>
            </button>
          </div>
        </Show>
      </div>
    );
  }
  return (
    <div class="page categories-manager-page">
      <div class="page-header">
        <h1 class="page-title">Categories</h1>
        <div class="category-manager-actions">
          <Show
            when={!reordering()}
            fallback={
              <button
                class="btn btn-secondary"
                disabled={busy()}
                onClick={() => setReordering(false)}
              >
                Done
              </button>
            }
          >
            <button
              class="btn btn-primary"
              disabled={!data() || busy()}
              onClick={() => setParams({ new: "1", group: undefined })}
            >
              <MoneyIcon name="plus" />
              Add
            </button>
            <details class="entity-menu" onToggle={placeMenu}>
              <summary aria-label="Category actions">
                <MoneyIcon name="more" />
              </summary>
              <div class="entity-menu-popover">
                <button
                  disabled={!data() || busy()}
                  onClick={(event) => {
                    closeMenu(event);
                    startGroup();
                  }}
                >
                  Add group
                </button>
                <button
                  disabled={!orderedCategories().length || busy()}
                  onClick={(event) => {
                    closeMenu(event);
                    setQuery("");
                    setReordering(true);
                  }}
                >
                  Reorder
                </button>
              </div>
            </details>
          </Show>
        </div>
      </div>
      <Show when={error() && !groupForm() && !deleting()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
      <PageState
        loading={result.loading && !data()}
        error={requestError(result())}
        onRetry={() => void refetch()}
      >
        <Show
          when={orderedCategories().length || orderedGroups().length}
          fallback={
            <div class="money-empty">
              <span class="money-empty-icon">
                <MoneyIcon name="budget" size={32} />
              </span>
              <h2>No categories yet</h2>
              <button class="btn btn-primary" onClick={() => setParams({ new: "1" })}>
                Add category
              </button>
            </div>
          }
        >
          <Show when={!reordering()}>
            <label class="category-manager-search compact-search">
              <MoneyIcon name="search" size={17} />
              <input
                type="search"
                aria-label="Find a category"
                placeholder="Find category"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
          </Show>
          <div class="category-manager-groups">
            <For each={orderedGroups().filter((row) => !row.hidden)}>
              {(group) => (
                <Show when={!query() || visibleRows(group.id).length}>
                  <section class="category-manager-group">
                    <div class="category-manager-group-heading">
                      <h2>{group.name}</h2>
                      <Show
                        when={reordering()}
                        fallback={
                          <details class="entity-menu" onToggle={placeMenu}>
                            <summary aria-label={`Actions for group ${group.name}`}>
                              <MoneyIcon name="more" size={18} />
                            </summary>
                            <div class="entity-menu-popover">
                              <button
                                disabled={busy()}
                                onClick={(event) => {
                                  closeMenu(event);
                                  setParams({ new: "1", group: group.id });
                                }}
                              >
                                Add category
                              </button>
                              <button
                                disabled={busy()}
                                onClick={(event) => {
                                  closeMenu(event);
                                  startGroup(group);
                                }}
                              >
                                Rename
                              </button>
                              <button
                                class="text-danger"
                                disabled={busy()}
                                onClick={(event) => {
                                  closeMenu(event);
                                  confirmDelete({ kind: "group", group });
                                }}
                              >
                                Delete group
                              </button>
                            </div>
                          </details>
                        }
                      >
                        <div class="reorder-controls">
                          <button
                            class="btn btn-icon btn-ghost"
                            aria-label={`Move group ${group.name} up`}
                            disabled={busy() || orderedGroups()[0]?.id === group.id}
                            onClick={() => void moveGroup(group, -1)}
                          >
                            ↑
                          </button>
                          <button
                            class="btn btn-icon btn-ghost"
                            aria-label={`Move group ${group.name} down`}
                            disabled={busy() || orderedGroups().at(-1)?.id === group.id}
                            onClick={() => void moveGroup(group, 1)}
                          >
                            ↓
                          </button>
                        </div>
                      </Show>
                    </div>
                    <For each={visibleRows(group.id)}>
                      {(category) => <CategoryRow category={category} />}
                    </For>
                    <Show when={!visibleRows(group.id).length}>
                      <button
                        class="category-group-add text-button"
                        disabled={busy()}
                        onClick={() => setParams({ new: "1", group: group.id })}
                      >
                        <MoneyIcon name="plus" size={16} />
                        Add category
                      </button>
                    </Show>
                  </section>
                </Show>
              )}
            </For>
            <For each={[false, true]}>
              {(income) => (
                <Show when={visibleRows(null, income).length}>
                  <section class="category-manager-group">
                    <div class="category-manager-group-heading">
                      <h2>{income ? "Income" : "Other"}</h2>
                    </div>
                    <For each={visibleRows(null, income)}>
                      {(category) => <CategoryRow category={category} />}
                    </For>
                  </section>
                </Show>
              )}
            </For>
          </div>
          <Show when={query() && !orderedCategories().some((row) => !row.hidden && matches(row))}>
            <p class="quiet-empty">No matching categories</p>
          </Show>
          <Show when={hiddenRows().length || orderedGroups().some((row) => row.hidden)}>
            <details class="category-hidden form-disclosure">
              <summary>
                Hidden <span>{hiddenRows().length}</span>
              </summary>
              <For each={orderedGroups().filter((row) => row.hidden)}>
                {(group) => (
                  <div class="category-hidden-group">
                    <strong>{group.name}</strong>
                    <button
                      class="text-button"
                      disabled={busy()}
                      onClick={() =>
                        void mutate(
                          "update_category_group",
                          { id: group.id, hidden: false },
                          {
                            undoInfo: {
                              label: "Show group",
                              inverse: {
                                commandType: "update_category_group",
                                payload: { id: group.id, hidden: true },
                              },
                            },
                          },
                        )
                      }
                    >
                      Show group
                    </button>
                  </div>
                )}
              </For>
              <For each={hiddenRows().filter(matches)}>
                {(category) => <CategoryRow category={category} />}
              </For>
            </details>
          </Show>
        </Show>
      </PageState>
      <Show when={data() && (params.new === "1" || editing())}>
        <CategoryEditor
          category={editing()}
          groups={orderedGroups()}
          initialGroupId={params.group}
          onClose={() => setParams({ new: undefined, edit: undefined, group: undefined })}
        />
      </Show>
      <Show when={groupForm()}>
        <MoneyDialog
          title={groupForm()?.mode === "create" ? "Add group" : "Rename group"}
          busy={busy()}
          onClose={() => setGroupForm(null)}
        >
          <form class="money-form" onSubmit={saveGroup}>
            <div class="form-group">
              <label for="group-name">Name</label>
              <input
                id="group-name"
                required
                value={groupName()}
                disabled={busy()}
                onInput={(event) => setGroupName(event.currentTarget.value)}
              />
            </div>
            <Show when={groupForm()?.mode === "create"}>
              <div class="form-group">
                <label for="group-type">Type</label>
                <select
                  id="group-type"
                  value={incomeGroup() ? "income" : "expense"}
                  disabled={busy()}
                  onChange={(event) => setIncomeGroup(event.currentTarget.value === "income")}
                >
                  <option value="expense">Expense</option>
                  <option value="income">Income</option>
                </select>
              </div>
            </Show>
            <Show when={error()}>
              <p class="form-error" role="alert">
                {error()}
              </p>
            </Show>
            <button type="submit" class="btn btn-primary btn-full" disabled={busy()}>
              {busy() ? "Saving…" : "Save group"}
            </button>
          </form>
        </MoneyDialog>
      </Show>
      <Show when={deleting()} keyed>
        {(value) => (
          <MoneyDialog
            title={`Delete ${value.kind === "category" ? value.category.name : value.group.name}?`}
            busy={busy()}
            onClose={() => setDeleting(null)}
          >
            <form class="money-form" onSubmit={remove}>
              <Show
                when={value.kind === "category"}
                fallback={<p class="delete-context">Categories and their history stay intact.</p>}
              >
                <p class="delete-context">Monthly assignments will be removed.</p>
              </Show>
              <div class="form-group">
                <label for="delete-destination">
                  {value.kind === "category" ? "Move activity to" : "Move categories to"}
                </label>
                <select
                  id="delete-destination"
                  value={destination()}
                  disabled={busy()}
                  onChange={(event) => setDestination(event.currentTarget.value)}
                >
                  <option value="">{value.kind === "category" ? "Uncategorized" : "Other"}</option>
                  <Show
                    when={value.kind === "category"}
                    fallback={
                      <For
                        each={orderedGroups().filter(
                          (row) =>
                            value.kind === "group" &&
                            row.id !== value.group.id &&
                            row.isIncome === value.group.isIncome,
                        )}
                      >
                        {(row) => <option value={row.id}>{row.name}</option>}
                      </For>
                    }
                  >
                    <For
                      each={orderedCategories().filter(
                        (row) =>
                          value.kind === "category" &&
                          row.id !== value.category.id &&
                          row.isIncome === value.category.isIncome &&
                          !row.hidden,
                      )}
                    >
                      {(row) => <option value={row.id}>{row.name}</option>}
                    </For>
                  </Show>
                </select>
              </div>
              <Show when={error()}>
                <p class="form-error" role="alert">
                  {error()}
                </p>
              </Show>
              <div class="form-actions">
                <button
                  type="button"
                  class="btn btn-secondary"
                  disabled={busy()}
                  onClick={() => setDeleting(null)}
                >
                  Cancel
                </button>
                <button type="submit" class="btn btn-danger" disabled={busy()}>
                  {busy() ? "Deleting…" : "Delete"}
                </button>
              </div>
            </form>
          </MoneyDialog>
        )}
      </Show>
    </div>
  );
}
