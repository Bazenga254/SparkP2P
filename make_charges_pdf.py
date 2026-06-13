from fpdf import FPDF

PESALINK = [
    ("1 - 100", 10), ("101 - 1,000", 10), ("1,001 - 2,500", 25), ("2,501 - 3,500", 25),
    ("3,501 - 5,000", 25), ("5,001 - 7,500", 25), ("7,501 - 10,000", 25), ("10,001 - 20,000", 25),
    ("20,001 - 30,000", 25), ("30,001 - 40,000", 25), ("40,001 - 50,000", 25), ("50,001 - 70,000", 25),
    ("70,001 - 100,000", 25), ("100,001 - 150,000", 25), ("150,001 - 999,999", 25),
]

MPESA = [
    ("1,501 - 2,500", 20), ("2,501 - 3,500", 21), ("3,501 - 5,000", 24), ("5,001 - 7,500", 24),
    ("7,501 - 10,000", 28), ("10,001 - 15,000", 28), ("15,001 - 20,000", 31), ("20,001 - 25,000", 31),
    ("25,001 - 30,000", 32), ("30,001 - 35,000", 39), ("35,001 - 40,000", 39), ("40,001 - 50,000", 40),
    ("50,001 - 70,000", 40), ("70,001 - 150,000", 40), ("150,001 - 250,000", 40),
]

NAVY = (31, 59, 110)
HEADER_BG = (31, 59, 110)
ROW_ALT = (240, 243, 250)

pdf = FPDF(orientation="P", unit="mm", format="A4")
pdf.set_auto_page_break(auto=True, margin=15)
pdf.add_page()

# Title
pdf.set_font("Helvetica", "B", 16)
pdf.set_text_color(*NAVY)
pdf.cell(0, 10, "Choice Bank Transaction Charges", new_x="LMARGIN", new_y="NEXT", align="L")

pdf.set_font("Helvetica", "", 10)
pdf.set_text_color(90, 90, 90)
pdf.multi_cell(0, 5, "Outbound transfer charges. All amounts in Kenya Shillings (KES).")
pdf.ln(3)

def draw_table(title, rows, note):
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(*NAVY)
    pdf.cell(0, 8, title, new_x="LMARGIN", new_y="NEXT")
    if note:
        pdf.set_font("Helvetica", "I", 9)
        pdf.set_text_color(110, 110, 110)
        pdf.cell(0, 5, note, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(1)

    col_w = [110, 60]
    row_h = 7
    # header
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_fill_color(*HEADER_BG)
    pdf.set_text_color(255, 255, 255)
    pdf.cell(col_w[0], row_h, "  Product (KES)", border=0, fill=True)
    pdf.cell(col_w[1], row_h, "Charge (KES)  ", border=0, fill=True, align="R",
             new_x="LMARGIN", new_y="NEXT")
    # rows
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(30, 30, 30)
    for i, (label, fee) in enumerate(rows):
        fill = i % 2 == 1
        if fill:
            pdf.set_fill_color(*ROW_ALT)
        pdf.cell(col_w[0], row_h, "  " + label, border="B", fill=fill)
        pdf.cell(col_w[1], row_h, f"{fee}  ", border="B", fill=fill, align="R",
                 new_x="LMARGIN", new_y="NEXT")
    pdf.ln(5)

draw_table("PesaLink Tariff (Outbound)", PESALINK, "")
draw_table("M-Pesa B2C Tariff", MPESA, "")

out = r"C:\Users\USER\Documents\AutoP2P\Choice_Bank_Transaction_Charges.pdf"
pdf.output(out)
print("WROTE", out)
