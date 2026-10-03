"""Scenario statements: one synthetic PDF per credit decision / validation path.

    pip install reportlab && python tools/make_scenarios.py

Writes test-statements/scenarios/*.pdf. Every statement is synthetic (made-up people and banks), Jan-Mar 2025,
one savings account, digital PDF with separate Debit / Credit columns and "Page X of Y" footers.
"""
import os, re
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas

OUT = os.path.join(os.path.dirname(__file__), '..', 'test-statements', 'scenarios')
MON = {1: 'JAN', 2: 'FEB', 3: 'MAR'}


def fmt(x):
    s = f"{x:,.2f}"; ip, dp = s.split('.'); ip = ip.replace(',', '')
    if len(ip) > 3:
        head, tail = ip[:-3], ip[-3:]
        ip = re.sub(r'(\d)(?=(\d\d)+$)', r'\1,', head) + ',' + tail
    return ip + '.' + dp


def build(rows, opening):
    """rows: (month, day, narration, amount, 'C'|'D') -> printed lines with running balance."""
    bal = opening; lines = []
    for m, d, n, a, t in sorted(rows, key=lambda r: (r[0], r[1])):
        bal = round(bal + a if t == 'C' else bal - a, 2)
        dt = f"{d:02d}/{m:02d}/2025"
        lines.append([dt, dt, n, fmt(a) if t == 'D' else '', fmt(a) if t == 'C' else '', fmt(bal)])
    return lines, bal


def draw(path, holder, acct, opening, lines, closing, per_page=14, page_order=None):
    W, H = landscape(A4); c = canvas.Canvas(path, pagesize=(W, H))
    pages = [lines[i:i + per_page] for i in range(0, len(lines), per_page)]; N = len(pages)
    for pi in (page_order or range(N)):
        pl = pages[pi]; y = H - 40
        c.setFont('Helvetica-Bold', 13); c.drawString(36, y, 'MERIDIAN BANK  |  Statement of Account'); y -= 18
        if pi == 0:
            c.setFont('Helvetica', 9)
            for k, v in [('Account Holder', holder), ('Account Number', acct), ('Account Type', 'Savings - Individual'), ('Currency', 'INR'),
                         ('Branch', 'Koramangala, Bengaluru'), ('Statement Period', '01/01/2025 to 31/03/2025'), ('Opening Balance', fmt(opening))]:
                c.drawString(36, y, f"{k}: {v}"); y -= 12
            y -= 6
        c.setFont('Helvetica-Bold', 8); cols = [36, 96, 156, 600, 670, 740]
        for x, h in zip(cols, ['Date', 'Value Date', 'Narration', 'Debit', 'Credit', 'Balance']): c.drawString(x, y, h)
        y -= 12; c.setFont('Helvetica', 7.4)
        for r in pl:
            c.drawString(cols[0], y, r[0]); c.drawString(cols[1], y, r[1]); c.drawString(cols[2], y, r[2][:88])
            c.drawRightString(cols[3] + 55, y, r[3]); c.drawRightString(cols[4] + 55, y, r[4]); c.drawRightString(cols[5] + 60, y, r[5]); y -= 13
        if pi == N - 1:
            y -= 8; c.setFont('Helvetica-Bold', 8.5); c.drawString(36, y, 'Closing Balance: ' + fmt(closing))
        c.setFont('Helvetica', 8); c.drawString(36, 24, f"Page {pi + 1} of {N}")
        c.drawRightString(W - 36, 24, 'This is a computer-generated synthetic statement for testing - not a real account.')
        c.showPage()
    c.save()


def monthly(fn):
    return [r for m in (1, 2, 3) for r in fn(m)]


SAL = lambda m, amt=145000: (m, 1, f'NEFT CR-CITI0000002-ACME TECHNOLOGIES PVT LTD-SALARY {MON[m]} 2025', amt, 'C')
EVERYDAY = lambda m: [
    (m, 5, f'BBPS/ELECTRICITY/NORTHGRID POWER/CA 1029384', [0, 2840, 2610, 2950][m], 'D'),
    (m, 7, f'UPI/50{m}712349876/FRESHBASKET MART/freshbasket@okaxis/Groceries', [0, 4120, 3870, 4310][m], 'D'),
    (m, 12, 'POS/XX8832/CITY FUELS SECTOR 29', [0, 2900, 3100, 2750][m], 'D'),
    (m, 16, 'BBPS/BROADBAND/SKYNET FIBER/AC 77812', 1179, 'D'),
    (m, 19, f'UPI/50{m}912340022/SPICE ROUTE CAFE/spiceroute@ybl/Dinner', [0, 1640, 2210, 1980][m], 'D'),
    (m, 24, f'UPI/50{m}412340066/FRESHBASKET MART/freshbasket@okaxis/Groceries', [0, 3420, 2960, 3010][m], 'D'),
]

SCENARIOS = {
    # 1. clean salaried customer: steady salary, one home-loan EMI, ordinary spending -> APPROVE
    '07_clean_salaried_approve.pdf': dict(holder='NEHA KULKARNI', acct='50100555566661', opening=120000, rows=monthly(lambda m: [
        SAL(m), (m, 3, f'ACH D-HOMEFIN LTD-LN0045821936-EMI {MON[m]}', 32000, 'D'),
        (m, 2, f'IMPS/P2A/50{m}212345671/SUNIL KAPOOR/House rent {MON[m]}', 18000, 'D'),
        (m, 6, 'ACH D-INDIAFIRST MF-SIP FOLIO 4471223', 10000, 'D')] + EVERYDAY(m))),
    # 2. one EMI bounce in February, re-presented and paid -> APPROVE WITH CONDITIONS (NACH mandate)
    '08_emi_bounce_conditions.pdf': dict(holder='RAHUL MENON', acct='50100555566662', opening=40000, rows=monthly(lambda m: [
        SAL(m), (m, 3, f'ACH D-HOMEFIN LTD-LN0045821936-EMI {MON[m]}', 32000, 'D')] + ([
        (2, 3, 'ACH RTN-HOMEFIN LTD-LN0045821936-INSUFFICIENT FUNDS', 32000, 'C'),
        (2, 4, 'NACH RTN CHGS-LN0045821936 INCL GST', 590, 'D'),
        (2, 8, 'ACH D-HOMEFIN LTD-LN0045821936-EMI FEB REPRESENT', 32000, 'D')] if m == 2 else []) + EVERYDAY(m))),
    # 3. EMIs take ~80% of income -> DECLINE (FOIR above the 65% hard limit), whatever the band
    '09_high_foir_decline.pdf': dict(holder='VIKAS SETHI', acct='50100555566663', opening=60000, rows=monthly(lambda m: [
        SAL(m, 62000), (m, 3, f'ACH D-HOMEFIN LTD-LN0045821936-EMI {MON[m]}', 34000, 'D'),
        (m, 5, 'ACH D-AUTOFIN BANK-LN7781200453-CAR LOAN EMI', 11500, 'D'),
        (m, 7, f'UPI/50{m}712349876/FRESHBASKET MART/freshbasket@okaxis/Groceries', 6000, 'D'),
        (m, 15, 'BBPS/ELECTRICITY/NORTHGRID POWER/CA 1029384', 2400, 'D')])),
    # 4. money in only from friends (P2P), no salary or business income -> DECLINE (no verifiable income)
    '10_no_income_decline.pdf': dict(holder='KARAN BHATIA', acct='50100555566664', opening=30000, rows=monthly(lambda m: [
        (m, 2, f'UPI/50{m}212345678/RAHUL VERMA/rahulv@oksbi/loan', [0, 20000, 8000, 25000][m], 'C'),
        (m, 10, f'IMPS/P2A/50{m}012345679/ANITA DESAI/Help', [0, 10000, 12000, 6000][m], 'C'),
        (m, 6, 'POS/XX8832/SHOPKART ONLINE', [0, 14000, 9000, 16000][m], 'D'),
        (m, 12, f'UPI/50{m}112340022/SPICE ROUTE CAFE/spiceroute@ybl/Dinner', 6000, 'D'),
        (m, 20, 'ATM WDL/S1AN2231/SECTOR 29 GURUGRAM', 8000, 'D'),
        (m, 26, 'LATE PAYMENT FEE', 750, 'D')])),
    # 5. same customer as 1, but one printed balance was edited by +10,000 -> REFER (possible tampering)
    '11_tampered_balance_refer.pdf': dict(holder='NEHA KULKARNI', acct='50100555566661', opening=120000, tamper=5, rows=monthly(lambda m: [
        SAL(m), (m, 3, f'ACH D-HOMEFIN LTD-LN0045821936-EMI {MON[m]}', 32000, 'D'),
        (m, 2, f'IMPS/P2A/50{m}212345671/SUNIL KAPOOR/House rent {MON[m]}', 18000, 'D'),
        (m, 6, 'ACH D-INDIAFIRST MF-SIP FOLIO 4471223', 10000, 'D')] + EVERYDAY(m))),
    # 6. pages 2 and 3 scanned in the wrong order -> pipeline stops with a clear "pages appear jumbled" error
    '12_jumbled_pages_error.pdf': dict(holder='NEHA KULKARNI', acct='50100555566661', opening=120000, per_page=8, page_order=[0, 2, 1, 3], rows=monthly(lambda m: [
        SAL(m), (m, 3, f'ACH D-HOMEFIN LTD-LN0045821936-EMI {MON[m]}', 32000, 'D'),
        (m, 2, f'IMPS/P2A/50{m}212345671/SUNIL KAPOOR/House rent {MON[m]}', 18000, 'D'),
        (m, 6, 'ACH D-INDIAFIRST MF-SIP FOLIO 4471223', 10000, 'D')] + EVERYDAY(m))),
    # 7. cheques (payee printed in several formats, a self cheque, payee not printed) and a transfer with no name
    #    -> channel CHEQUE, payee read where printed; the rows with no counterparty go to the Review queue
    '13_cheques_review.pdf': dict(holder='PRIYA NAIR', acct='50100555566667', opening=90000, rows=monthly(lambda m: [SAL(m)] + EVERYDAY(m)) + [
        (1, 9, 'CHQ PAID-000451-SHARMA TRADERS', 15500, 'D'),
        (1, 21, 'TO CLG CHQ NO 000452 MEHTA & SONS', 8200, 'D'),
        (2, 9, 'BY CLG/ICIC/000123/VIKRAM ENTERPRISES', 12000, 'C'),
        (2, 22, 'CHQ NO. 000453/SELF/CASH WDL', 10000, 'D'),
        (3, 9, 'CHEQUE NO 112233 ISSUED TO GREENVIEW RWA', 9000, 'D'),
        (3, 14, 'CLG CHQ 000454', 7300, 'D'),
        (3, 27, 'TRF/0091823/MISC', 2000, 'D')]),
}

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for name, s in SCENARIOS.items():
        lines, closing = build(s['rows'], s['opening'])
        if s.get('tamper') is not None:
            i = s['tamper']; v = float(lines[i][5].replace(',', '')) + 10000; lines[i][5] = fmt(v)
        draw(os.path.join(OUT, name), s['holder'], s['acct'], s['opening'], lines, closing, s.get('per_page', 14), s.get('page_order'))
        print(name, len(lines), 'rows')
