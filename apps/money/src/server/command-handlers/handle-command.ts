import { handleSetup } from "./setup";
import type { Db } from "../d1-access";
import { decodeCommandInvocation, type CommandInvocation } from "../../domain/commands";
import { isSyncCommandType, type CommandResult } from "../../domain/types";
import { handleAccountCommands } from "./accounts";
import { handleTransactionCommands } from "./transactions";
import { handleCategoryCommands } from "./categories";
import { handleBudgetCommands } from "./budget";
import { handlePayeeCommands } from "./payees";
import { handleScheduleCommands } from "./schedules";
import { handleRuleCommands } from "./rules";
import { handleTagCommands } from "./tags";
import { handleImportCommands } from "./import";
import { handleFilterCommands } from "./filters";
import { handleReportCommands } from "./reports";
import { handleSettingCommands } from "./settings";
import { handleNotesCommands } from "./notes";
import { handleDashboardCommands } from "./dashboard";

export type { CommandResult } from "../../domain/types";

export interface CommandRequest {
  commandType: string;
  payload: unknown;
}

export async function handleCommand(db: Db, body: CommandRequest): Promise<CommandResult> {
  const commandType = body.commandType;
  if (!isSyncCommandType(commandType)) {
    return { ok: false, error: `Unknown command: ${commandType}` };
  }

  try {
    return routeCommand(decodeCommandInvocation(commandType, body.payload), db);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Validation failed" };
  }
}

async function routeCommand(command: CommandInvocation, db: Db): Promise<CommandResult> {
  switch (command.commandType) {
    case "setup_money":
      return handleSetup(command, db);
    case "create_account":
    case "update_account":
    case "delete_account":
    case "close_account":
    case "reopen_account":
    case "reorder_accounts":
    case "update_exchange_rate":
    case "reconcile_account":
      return handleAccountCommands(command, db);

    case "create_transaction":
    case "create_account_transfer":
    case "delete_account_transfer":
    case "update_transaction":
    case "delete_transaction":
    case "split_transaction":
      return handleTransactionCommands(command, db);

    case "create_category":
    case "update_category":
    case "delete_category":
    case "create_category_group":
    case "update_category_group":
    case "delete_category_group":
    case "reorder_category_groups":
    case "reorder_categories":
      return handleCategoryCommands(command, db);

    case "set_budget_amount":
    case "allocate_budget":
    case "set_budget_plan":
    case "set_budget_carryover":
    case "set_buffer":
    case "copy_previous_month":
    case "set_3month_avg":
    case "set_nmonth_avg":
    case "set_zero":
    case "apply_goal_templates":
    case "cover_overspending":
    case "transfer_budget":
    case "hold_for_next_month":
      return handleBudgetCommands(command, db);

    case "create_payee":
    case "update_payee":
    case "delete_payee":
    case "merge_payees":
      return handlePayeeCommands(command, db);

    case "create_schedule":
    case "update_schedule":
    case "delete_schedule":
    case "skip_schedule_date":
    case "post_schedule_transaction":
    case "undo_schedule_payment":
      return handleScheduleCommands(command, db);

    case "create_rule":
    case "update_rule":
    case "delete_rule":
      return handleRuleCommands(command, db);

    case "create_tag":
    case "delete_tag":
    case "add_transaction_tag":
    case "remove_transaction_tag":
      return handleTagCommands(command, db);

    case "import_transactions":
    case "undo_transaction_import":
      return handleImportCommands(command, db);

    case "create_filter":
    case "update_filter":
    case "delete_filter":
      return handleFilterCommands(command, db);

    case "create_report":
    case "update_report":
    case "delete_report":
      return handleReportCommands(command, db);

    case "update_setting":
      return handleSettingCommands(command, db);

    case "create_note":
    case "update_note":
    case "delete_note":
    case "list_notes":
      return handleNotesCommands(command, db);

    case "update_dashboard":
      return handleDashboardCommands(command, db);

    default:
      return { ok: false, error: "Unhandled command" };
  }
}
