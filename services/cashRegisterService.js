import CashRegister from '../models/cashRegister.js';
import Transaction from '../models/transaction.js';
import { isValidObjectId, parseNonNegativeNumber, sanitizeString } from '../utils/validate.js';

const INCOME_TYPES = ['service_payment', 'product_sale', 'tip'];
const EXPENSE_TYPES = ['expense', 'payout'];
const VALID_TYPES = [...INCOME_TYPES, ...EXPENSE_TYPES];
const VALID_PAYMENT_METHODS = ['cash', 'click', 'payme', 'terminal_uzcard_humo', 'other'];

export async function openRegister(shopId, openedBy, openingCashBalance = 0) {
  const parsedOpening = openingCashBalance === undefined || openingCashBalance === null
    ? 0
    : parseNonNegativeNumber(openingCashBalance);

  if (parsedOpening === null) {
    const err = new Error('openingCashBalance must be a valid non-negative number');
    err.statusCode = 400;
    throw err;
  }

  const existing = await CashRegister.findOne({ shopId, status: 'open' });
  if (existing) {
    const err = new Error('A register session is already open for this shop');
    err.statusCode = 409;
    throw err;
  }

  try {
    const register = await CashRegister.create({
      shopId,
      openedBy,
      openedAt: new Date(),
      openingCashBalance: parsedOpening,
      status: 'open',
    });
    return register;
  } catch (err) {
    if (err.code === 11000) {
      const conflictErr = new Error('A register session is already open for this shop');
      conflictErr.statusCode = 409;
      throw conflictErr;
    }
    throw err;
  }
}

export async function calculateRegisterSummary(register) {
  const txs = await Transaction.find({ registerId: register._id });

  const breakdownByMethod = {
    cash: 0,
    click: 0,
    payme: 0,
    terminal_uzcard_humo: 0,
    other: 0,
  };

  let totalIncome = 0;
  let totalExpense = 0;
  let cashExpense = 0;

  for (const tx of txs) {
    const amt = Number(tx.amount) || 0;
    if (INCOME_TYPES.includes(tx.type)) {
      totalIncome += amt;
      const method = Object.prototype.hasOwnProperty.call(breakdownByMethod, tx.paymentMethod)
        ? tx.paymentMethod
        : 'other';
      breakdownByMethod[method] += amt;
    } else if (EXPENSE_TYPES.includes(tx.type)) {
      totalExpense += amt;
      if (tx.paymentMethod === 'cash') {
        cashExpense += amt;
      }
    }
  }

  const expectedCashBalance = (Number(register.openingCashBalance) || 0) + breakdownByMethod.cash - cashExpense;

  return {
    totalIncome,
    totalExpense,
    netRevenue: totalIncome - totalExpense,
    breakdownByMethod,
    cashExpense,
    expectedCashBalance,
    transactionsCount: txs.length,
  };
}

export async function getCurrentRegisterStatus(shopId) {
  const register = await CashRegister.findOne({ shopId, status: 'open' });
  if (!register) return null;

  const summary = await calculateRegisterSummary(register);
  return {
    register,
    summary,
  };
}

export async function recordTransaction(shopId, data) {
  if (!data || !VALID_TYPES.includes(data.type)) {
    const err = new Error(`Invalid transaction type. Must be one of: ${VALID_TYPES.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const paymentMethod = data.paymentMethod || 'cash';
  if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
    const err = new Error(`Invalid paymentMethod. Must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const amount = parseNonNegativeNumber(data.amount);
  if (amount === null) {
    const err = new Error('Transaction amount must be a valid non-negative number');
    err.statusCode = 400;
    throw err;
  }

  if (data.bookingId && !isValidObjectId(data.bookingId)) {
    const err = new Error('Invalid bookingId');
    err.statusCode = 400;
    throw err;
  }

  if (data.staffId && !isValidObjectId(data.staffId)) {
    const err = new Error('Invalid staffId');
    err.statusCode = 400;
    throw err;
  }

  const register = await CashRegister.findOne({ shopId, status: 'open' });
  if (!register) {
    const err = new Error('No open register session found. Please open the cash register first.');
    err.statusCode = 400;
    throw err;
  }

  const tx = await Transaction.create({
    shopId,
    registerId: register._id,
    bookingId: data.bookingId || null,
    type: data.type,
    amount,
    paymentMethod,
    staffId: data.staffId || null,
    staffName: sanitizeString(data.staffName, 120),
    description: sanitizeString(data.description, 300),
    customerName: sanitizeString(data.customerName, 120),
    customerPhone: sanitizeString(data.customerPhone, 30),
    recordedBy: data.recordedBy || null,
  });

  return tx;
}

export async function closeRegister(shopId, closedBy, closingCashBalance, notes = '') {
  const actualCash = parseNonNegativeNumber(closingCashBalance);
  if (actualCash === null) {
    const err = new Error('closingCashBalance must be a valid non-negative number');
    err.statusCode = 400;
    throw err;
  }

  const register = await CashRegister.findOne({ shopId, status: 'open' });
  if (!register) {
    const err = new Error('No open register session found to close');
    err.statusCode = 404;
    throw err;
  }

  const summary = await calculateRegisterSummary(register);
  const discrepancy = actualCash - summary.expectedCashBalance;

  register.closedBy = closedBy;
  register.closedAt = new Date();
  register.closingCashBalance = actualCash;
  register.expectedCashBalance = summary.expectedCashBalance;
  register.cashDiscrepancy = discrepancy;
  register.totalIncome = summary.totalIncome;
  register.totalExpense = summary.totalExpense;
  register.breakdownByMethod = summary.breakdownByMethod;
  register.status = 'closed';
  register.notes = sanitizeString(notes, 500);

  await register.save();

  return {
    zReport: register,
    summary,
  };
}
