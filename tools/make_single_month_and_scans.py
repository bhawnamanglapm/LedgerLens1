import random, json, re
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
random.seed(7)
def fmt(x): 
    s=f"{x:,.2f}"; # convert to Indian grouping
    ip, dp = s.split('.'); ip=ip.replace(',','')
    if len(ip)>3:
        head, tail = ip[:-3], ip[-3:]
        head = re.sub(r'(\d)(?=(\d\d)+$)', r'\1,', head)
        ip = head+','+tail
    return ip+'.'+dp
# ---------- 1) single-month digital PDF (plain text columns, HDFC/SBI/ICICI style narrations) ----------
rows=[]
def add(d,n,a,t): rows.append((d,n,a,t))
add(1,'NEFT CR-HDFC0000240-BRIGHTWAVE SOLUTIONS PVT LTD-SALARY JAN 2025-N012500113',96500,'C')
add(2,'UPI-RAJIV MALHOTRA-rajiv.m@okhdfcbank-HDFC0001234-501234567890-RENT JAN',22000,'D')
add(3,'ACH D- TATA CAPITAL LTD-TCL0098812345',11850,'D')
add(4,'UPI-BLINKIT-blinkit@hdfcbank-HDFC0000001-501234567891-UPI',1245.5,'D')
add(5,'POS 416021XXXXXX4521 DMART AVENUE SUPERMARTS',3420,'D')
add(5,'BIL/ONL/000412345/BESCOM/JAN25',1860,'D')
add(6,'UPI-SWIGGY-swiggy@icici-ICIC0DC0099-501234567892-UPI',486,'D')
add(7,'NWD-416021XXXXXX4521-S1AN0123-BENGALURU',3000,'D')
add(8,'TO TRANSFER-UPI/DR/501234567893/MEERA IYER/SBIN/meera@oksbi/UPI--',1500,'D')
add(9,'UPI/P2M/501234567894/AIRTEL PAYMENTS/Recharge/AXIS',599,'D')
add(10,'IMPS-501234567895-KARTIK RAO-KKBK-XXXXXXXX7712-DINNER SHARE',1200,'C')
add(11,'ACH D- ICICI PRU LIFE INSURANCE-POLICY 77812',4250,'D')
add(12,'UPI-ZEPTO-zepto@ybl-YESB0YBLUPI-501234567896-UPI',892,'D')
add(13,'NEFT DR-SBIN0004567-GREENFIELD SCHOOL TRUST-Tuition fee Q4-N013500777',18500,'D')
add(14,'UPI-UBER INDIA-uber@axisbank-UTIB0000001-501234567897-RIDE',342,'D')
add(15,'ACH D- ZERODHA BROKING-SIP 2211',5000,'D')
add(16,'UPI-AMAZON PAY INDIA PRIVA-amazonpay@apl-UTIB0000002-501234567898-ORDER',2799,'D')
add(17,'UPI/REFUND/AMAZON PAY INDIA/Order 405-112 return',899,'C')
add(18,'POS 416021XXXXXX4521 HPCL FUEL STATION',2500,'D')
add(19,'UPI-APOLLO PHARMACY-apollo@icici-ICIC0000003-501234567899-MEDICINE',735,'D')
add(20,'UPI-SHARMA PROVISION STORE-q7xk2@ybl-YESB0YBLUPI-501234567900-',640,'D')
add(21,'BIL/ONL/000412377/ACT FIBERNET/JAN25',1180,'D')
add(22,'UPI-NETFLIX-netflix@hdfcbank-HDFC0000004-501234567901-SUBSCRIPTION',649,'D')
add(23,'IMPS-501234567902-ANANYA SINGH-HDFC-XXXXXXXX3390-TRIP',4500,'D')
add(24,'UPI-BLINKIT-blinkit@hdfcbank-HDFC0000001-501234567903-UPI',1532.4,'D')
add(25,'CC PAYMENT/MERIDIAN CARD XX9921/AUTOPAY',14320,'D')
add(26,'UPI-ZOMATO-zomato@kotak-KKBK0000005-501234567904-UPI',612,'D')
add(27,'NEFT CR-ICIC0000104-STRIPE PAYMENTS INDIA-PAYOUT po_1QJ',12400,'C')
add(28,'TRF/0099123/MISC',1000,'D')
add(29,'SMS ALERT CHGS QTR INCL GST',17.7,'D')
add(30,'UPI-DMART READY-dmart@icici-ICIC0000006-501234567905-UPI',2210,'D')
add(31,'CREDIT INTEREST CAPITALISED',312,'C')
opening=58420.0
def build_lines(rows, opening):
    out=[]; b=opening
    for d,n,a,t in rows:
        b=round(b-a if t=='D' else b+a,2)
        out.append((f"{d:02d}/01/2025", f"{d:02d}/01/2025", n, fmt(a) if t=='D' else '', fmt(a) if t=='C' else '', fmt(b)))
    return out, b
lines, closing = build_lines(rows, opening)
def draw_statement(path, header, lines, closing, per_page=18, month_label='01/01/2025 to 31/01/2025'):
    c=canvas.Canvas(path, pagesize=landscape(A4)); W,H=landscape(A4)
    pages=[lines[i:i+per_page] for i in range(0,len(lines),per_page)]
    N=len(pages)
    for pi,pl in enumerate(pages):
        y=H-40
        c.setFont('Helvetica-Bold',13); c.drawString(36,y,header['bank']+'  |  Statement of Account'); y-=18
        if pi==0:
            c.setFont('Helvetica',9)
            for k in ['Account Holder','Account Number','Account Type','Currency','Branch','Statement Period','Opening Balance']:
                c.drawString(36,y,f"{k}: {header[k]}"); y-=12
            y-=6
        c.setFont('Helvetica-Bold',8)
        cols=[36,96,156,600,670,740]
        for x,h in zip(cols,['Date','Value Date','Narration','Debit','Credit','Balance']): c.drawString(x,y,h)
        y-=12; c.setFont('Helvetica',7.4)
        for r in pl:
            c.drawString(cols[0],y,r[0]); c.drawString(cols[1],y,r[1]); c.drawString(cols[2],y,r[2][:88])
            c.drawRightString(cols[3]+55,y,r[3]); c.drawRightString(cols[4]+55,y,r[4]); c.drawRightString(cols[5]+60,y,r[5]); y-=13
        if pi==N-1:
            y-=8; c.setFont('Helvetica-Bold',8.5); c.drawString(36,y,'Closing Balance: '+fmt(closing))
        c.setFont('Helvetica',8); c.drawString(36,24,f"Page {pi+1} of {N}"); c.drawRightString(W-36,24,'This is a computer-generated synthetic statement for testing — not a real account.')
        c.showPage()
    c.save()
hdr={'bank':'MERIDIAN BANK','Account Holder':'ARJUN NAIR','Account Number':'50200011223344','Account Type':'Savings - Individual','Currency':'INR','Branch':'Indiranagar, Bengaluru','Statement Period':'01/01/2025 to 31/01/2025','Opening Balance':fmt(opening)}
draw_statement('test-statements/01_single_month_digital.pdf', hdr, lines, closing)
json.dump({'rows':len(rows),'opening':opening,'closing':closing},open('meta1.json','w'))
print('single', len(rows), closing)
