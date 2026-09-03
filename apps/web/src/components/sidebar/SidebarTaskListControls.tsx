import {
  Fragment,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ListFilter,
  MoreHorizontal,
} from "../icons";
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
  groupByProject,
  noun,
  onFilterChange,
  onGroupByProjectChange,
  onOnlyRunningTasksChange,
  onShowCodexChatsChange,
  onTasksetChange,
  onSortChange,
  onlyRunningTasks,
  openMenu,
  setOpenMenu,
  showCodexChats,
  sort,
  selectedTasksetId,
  tasksets,
}: {
  filter: SidebarTaskFilter;
  groupByProject: boolean;
  noun: "chats" | "tasks";
  onFilterChange: (filter: SidebarTaskFilter) => void;
  onGroupByProjectChange: (groupByProject: boolean) => void;
  onOnlyRunningTasksChange: (onlyRunningTasks: boolean) => void;
  onShowCodexChatsChange: (showCodexChats: boolean) => void;
  onTasksetChange: (tasksetId: string | null) => void;
  onSortChange: (sort: SidebarTaskSort) => void;
  onlyRunningTasks: boolean;
  openMenu: SidebarSectionMenuId | null;
  setOpenMenu: Dispatch<SetStateAction<SidebarSectionMenuId | null>>;
  showCodexChats: boolean;
  sort: SidebarTaskSort;
  selectedTasksetId: string | null;
  tasksets: readonly SidebarTasksetFilterOption[];
}) {
  const [tasksetsExpanded, setTasksetsExpanded] = useState(false);
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
          className={`section-icon ${
            sortMenuOpen || !showCodexChats || onlyRunningTasks ? "active" : ""
          }`}
          aria-label={`${noun === "tasks" ? "Task" : "Chat"} list options`}
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
            aria-label={`${noun === "tasks" ? "Task" : "Chat"} list options`}
          >
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={showCodexChats}
              onClick={() => onShowCodexChatsChange(!showCodexChats)}
            >
              <span className="section-menu-check" aria-hidden="true">
                {showCodexChats ? <Check size={13} /> : null}
              </span>
              <span>Show Codex chats</span>
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={onlyRunningTasks}
              onClick={() => onOnlyRunningTasksChange(!onlyRunningTasks)}
            >
              <span className="section-menu-check" aria-hidden="true">
                {onlyRunningTasks ? <Check size={13} /> : null}
              </span>
              <span>Only running tasks</span>
            </button>
            {noun === "tasks" ? (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={groupByProject}
                onClick={() => onGroupByProjectChange(!groupByProject)}
              >
                <span className="section-menu-check" aria-hidden="true">
                  {groupByProject ? <Check size={13} /> : null}
                </span>
                <span>Group by project</span>
              </button>
            ) : null}
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
                {option.value === "tasksets" ? (
                  <button
                    type="button"
                    role="menuitem"
                    aria-expanded={tasksetsExpanded}
                    onClick={() => setTasksetsExpanded((current) => !current)}
                  >
                    <span className="section-menu-check" aria-hidden="true">
                      {tasksetsExpanded ? (
                        <ChevronDown size={13} />
                      ) : (
                        <ChevronRight size={13} />
                      )}
                    </span>
                    <span>{option.label}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={filter === option.value}
                    onClick={() => {
                      onFilterChange(option.value);
                      setOpenMenu(null);
                    }}
                  >
                    <span className="section-menu-check" aria-hidden="true">
                      {filter === option.value ? <Check size={13} /> : null}
                    </span>
                    <span>{option.label}</span>
                  </button>
                )}
                {option.value === "tasksets" && tasksetsExpanded ? (
                  <>
                    <button
                      className="section-menu-taskset-option"
                      type="button"
                      role="menuitemradio"
                      aria-checked={filter === "tasksets" && !selectedTasksetId}
                      onClick={() => {
                        onTasksetChange(null);
                        setOpenMenu(null);
                      }}
                    >
                      <span className="section-menu-check" aria-hidden="true">
                        {filter === "tasksets" && !selectedTasksetId ? (
                          <Check size={13} />
                        ) : null}
                      </span>
                      <span>All Tasksets</span>
                    </button>
                    {tasksets.map((taskset) => (
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
                    ))}
                  </>
                ) : null}
              </Fragment>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
