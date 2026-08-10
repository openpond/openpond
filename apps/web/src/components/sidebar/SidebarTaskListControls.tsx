import { Fragment, type Dispatch, type SetStateAction } from "react";
import { Check, ListFilter, MoreHorizontal } from "../icons";
import type { SidebarSectionMenuId } from "../../app/app-state";
import {
  SIDEBAR_TASK_FILTER_OPTIONS,
  SIDEBAR_TASK_SORT_OPTIONS,
  type SidebarTaskFilter,
  type SidebarTaskSort,
  type SidebarTasksetFilterOption,
} from "../../lib/sidebar-task-list";

export function SidebarTaskListControls({
  filter,
  noun,
  onFilterChange,
  onTasksetChange,
  onSortChange,
  openMenu,
  setOpenMenu,
  sort,
  selectedTasksetId,
  tasksets,
}: {
  filter: SidebarTaskFilter;
  noun: "chats" | "tasks";
  onFilterChange: (filter: SidebarTaskFilter) => void;
  onTasksetChange: (tasksetId: string | null) => void;
  onSortChange: (sort: SidebarTaskSort) => void;
  openMenu: SidebarSectionMenuId | null;
  setOpenMenu: Dispatch<SetStateAction<SidebarSectionMenuId | null>>;
  sort: SidebarTaskSort;
  selectedTasksetId: string | null;
  tasksets: readonly SidebarTasksetFilterOption[];
}) {
  const selectedTaskset = tasksets.find(
    (taskset) => taskset.id === selectedTasksetId
  );
  const filterLabel =
    selectedTaskset?.name ??
    SIDEBAR_TASK_FILTER_OPTIONS.find((option) => option.value === filter)
      ?.label ??
    "Active";
  const filterMenuOpen = openMenu === "tasks-filter";
  const sortMenuOpen = openMenu === "chats";

  return (
    <>
      <div className="section-menu">
        <button
          type="button"
          className={`section-icon ${sortMenuOpen ? "active" : ""}`}
          aria-label={`Sort ${noun}`}
          aria-haspopup="menu"
          aria-expanded={sortMenuOpen}
          onClick={() =>
            setOpenMenu((current) => (current === "chats" ? null : "chats"))
          }
        >
          <MoreHorizontal size={14} />
        </button>
        {sortMenuOpen ? (
          <div
            className="section-menu-popover"
            role="menu"
            aria-label={`Sort ${noun}`}
          >
            {SIDEBAR_TASK_SORT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={sort === option.value}
                onClick={() => {
                  onSortChange(option.value);
                  setOpenMenu(null);
                }}
              >
                <span className="section-menu-check" aria-hidden="true">
                  {sort === option.value ? <Check size={13} /> : null}
                </span>
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="section-menu">
        <button
          type="button"
          className={`section-icon ${
            filterMenuOpen || filter !== "active" ? "active" : ""
          }`}
          aria-label={`Filter ${noun}: ${filterLabel}`}
          aria-haspopup="menu"
          aria-expanded={filterMenuOpen}
          onClick={() =>
            setOpenMenu((current) =>
              current === "tasks-filter" ? null : "tasks-filter"
            )
          }
        >
          <ListFilter size={14} />
        </button>
        {filterMenuOpen ? (
          <div
            className="section-menu-popover"
            role="menu"
            aria-label={`Filter ${noun}`}
          >
            {SIDEBAR_TASK_FILTER_OPTIONS.map((option) => (
              <Fragment key={option.value}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={filter === option.value && !selectedTasksetId}
                  onClick={() => {
                    if (option.value === "tasksets") onTasksetChange(null);
                    else onFilterChange(option.value);
                    setOpenMenu(null);
                  }}
                >
                  <span className="section-menu-check" aria-hidden="true">
                    {filter === option.value && !selectedTasksetId ? (
                      <Check size={13} />
                    ) : null}
                  </span>
                  <span>{option.label}</span>
                </button>
                {option.value === "tasksets"
                  ? tasksets.map((taskset) => (
                      <button
                        className="section-menu-taskset-option"
                        key={taskset.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={
                          filter === "tasksets" &&
                          selectedTasksetId === taskset.id
                        }
                        onClick={() => {
                          onTasksetChange(taskset.id);
                          setOpenMenu(null);
                        }}
                      >
                        <span className="section-menu-check" aria-hidden="true">
                          {filter === "tasksets" &&
                          selectedTasksetId === taskset.id ? (
                            <Check size={13} />
                          ) : null}
                        </span>
                        <span>{taskset.name}</span>
                        <span
                          className="section-menu-option-count"
                          aria-hidden="true"
                        >
                          {taskset.chatCount}
                        </span>
                      </button>
                    ))
                  : null}
              </Fragment>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
