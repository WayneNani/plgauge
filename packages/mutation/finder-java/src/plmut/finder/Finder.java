package plmut.finder;

import ch.islandsql.grammar.IslandSqlDialect;
import ch.islandsql.grammar.IslandSqlLexer;
import ch.islandsql.grammar.IslandSqlParser;
import ch.islandsql.grammar.util.SyntaxErrorEntry;
import ch.islandsql.grammar.util.SyntaxErrorListener;
import org.antlr.v4.runtime.*;
import org.antlr.v4.runtime.tree.*;

import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/**
 * Finds mutation points in PL/SQL source files and prints them as JSON.
 *
 * Usage: Finder file...
 *
 * Every point names a span of the file (byte offsets, end exclusive), the
 * original text of that span and the replacement texts of its mutants. Both
 * rewriters of plmut work on these spans: the oracle replaces one span per
 * mutant, the schema rewriter wraps every span in a switch.
 */
public final class Finder {

    public static void main(String[] args) throws Exception {
        StringBuilder out = new StringBuilder("{\"files\":[");
        for (int i = 0; i < args.length; i++) {
            if (i > 0) out.append(',');
            Path p = Paths.get(args[i]);
            try {
                out.append(new Finder(p).run());
            } catch (java.nio.charset.CharacterCodingException e) {
                out.append("{\"path\":" + q(p.toString()) + ",\"errors\":[\"keine UTF-8-Datei\"],\"units\":[],\"points\":[],\"loops\":[]}");
            }
        }
        System.out.println(out.append("]}"));
    }

    private final Path path;
    private final String src;
    private final List<int[]> conditional; // $if blocks as UTF-16 index ranges, no mutants inside
    private final int[] byteOf; // code point index -> byte offset
    private final int[] charOf; // code point index -> UTF-16 index
    private final List<String> units = new ArrayList<>();
    private final List<String> points = new ArrayList<>();
    private final List<String> loops = new ArrayList<>();
    private int skipped; // variants left out as equivalent or meaningless
    private int unit = -1;

    private Finder(Path path) throws Exception {
        this.path = path;
        StringBuilder text = new StringBuilder(blankSqlPlus(Files.readString(path, StandardCharsets.UTF_8)));
        this.conditional = blankConditional(text);
        this.src = text.toString();
        int[] cps = src.codePoints().toArray();
        byteOf = new int[cps.length + 1];
        charOf = new int[cps.length + 1];
        int b = 0, ch = 0;
        for (int i = 0; i < cps.length; i++) {
            byteOf[i] = b;
            charOf[i] = ch;
            ch += Character.charCount(cps[i]);
            int c = cps[i];
            b += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        }
        byteOf[cps.length] = b;
        charOf[cps.length] = ch;
    }

    private static final java.util.regex.Pattern SQLPLUS = java.util.regex.Pattern.compile(
            "(?i)^\\s*(SHOW|SHO|SET|PROMPT|PRO|REM|REMARK|WHENEVER|SPOOL|DEFINE|UNDEFINE|COLUMN|COL|TTITLE|BTITLE|PAUSE|CLEAR|EXEC|EXECUTE|CONNECT|CONN|DISCONNECT|EXIT|QUIT|@)(\\b|@|$).*");
    private static final java.util.regex.Pattern CREATE = java.util.regex.Pattern.compile("(?i)^\\s*CREATE\\b.*");

    /**
     * Replaces SQL*Plus commands outside of CREATE statements with spaces,
     * one space per UTF-8 byte, so that byte offsets stay valid.
     */
    static String blankSqlPlus(String s) {
        StringBuilder out = new StringBuilder(s.length());
        boolean inUnit = false;
        for (String line : s.split("(?<=\\n)", -1)) {
            String body = line.endsWith("\n") ? line.substring(0, line.length() - 1) : line;
            String trimmed = body.strip();
            if (!inUnit && CREATE.matcher(body).matches()) {
                inUnit = true;
            }
            if (trimmed.equals("/")) {
                inUnit = false;
            } else if (!inUnit && SQLPLUS.matcher(body).matches()) {
                int bytes = body.getBytes(StandardCharsets.UTF_8).length;
                out.append(" ".repeat(bytes)).append(line.endsWith("\n") ? "\n" : "");
                continue;
            }
            out.append(line);
        }
        return out.toString();
    }

    /**
     * Conditional compilation: the parser cannot read $if blocks, and only
     * the database knows which branch is active. For parsing, every $if block
     * keeps its last branch (usually the code for current versions); the
     * directives and the other branches become spaces, one per UTF-8 byte.
     * No mutants are placed inside such blocks. Returns the block ranges.
     */
    static List<int[]> blankConditional(StringBuilder s) {
        List<int[]> blocks = new ArrayList<>();
        Deque<List<int[]>> stack = new ArrayDeque<>(); // per open block: directive ranges and branch bodies
        Deque<Integer> starts = new ArrayDeque<>();
        for (int i = 0; i < s.length(); i++) {
            int n = s.length();
            char c = s.charAt(i);
            if (c == '-' && i + 1 < n && s.charAt(i + 1) == '-') {
                while (i < n && s.charAt(i) != '\n') i++;
                continue;
            }
            if (c == '/' && i + 1 < n && s.charAt(i + 1) == '*') {
                int e = s.indexOf("*/", i + 2);
                i = e < 0 ? n : e + 1;
                continue;
            }
            if (c == '\'') {
                i++;
                while (i < n && !(s.charAt(i) == '\'' && (i + 1 >= n || s.charAt(i + 1) != '\''))) {
                    if (s.charAt(i) == '\'') i++;
                    i++;
                }
                continue;
            }
            if (c != '$' || i + 1 >= n || s.charAt(i + 1) == '$') {
                if (c == '$' && i + 1 < n) i++; // $$inquiry directive
                continue;
            }
            String word = directive(s, i);
            switch (word) {
                case "$IF" -> {
                    starts.push(i);
                    List<int[]> parts = new ArrayList<>();
                    int then = indexOfWord(s, "$THEN", i);
                    if (then < 0) return blocks;
                    parts.add(new int[]{i, then + 5}); // directive
                    stack.push(parts);
                    i = then + 4;
                }
                case "$ELSIF" -> {
                    if (stack.isEmpty()) return blocks;
                    int then = indexOfWord(s, "$THEN", i);
                    if (then < 0) return blocks;
                    stack.peek().add(new int[]{i, then + 5});
                    i = then + 4;
                }
                case "$ELSE" -> {
                    if (stack.isEmpty()) return blocks;
                    stack.peek().add(new int[]{i, i + 5});
                    i += 4;
                }
                case "$ERROR" -> {
                    int end = indexOfWord(s, "$END", i);
                    if (end < 0) return blocks;
                    i = end + 3 + blank(s, i, end + 4);
                }
                case "$END" -> {
                    if (stack.isEmpty()) return blocks;
                    List<int[]> parts = stack.pop();
                    int start = starts.pop();
                    // Blank every directive and every branch body but the last one,
                    // from the back so that earlier positions stay valid.
                    List<int[]> cut = new ArrayList<>();
                    for (int k = 0; k < parts.size(); k++) {
                        int[] d = parts.get(k);
                        cut.add(new int[]{d[0], k + 1 < parts.size() ? parts.get(k + 1)[0] : d[1]});
                    }
                    cut.add(new int[]{i, i + 4});
                    int grow = 0;
                    for (int k = cut.size() - 1; k >= 0; k--) grow += blank(s, cut.get(k)[0], cut.get(k)[1]);
                    blocks.add(new int[]{start, i + 4 + grow});
                    i += 3 + grow;
                }
                default -> {}
            }
        }
        return blocks;
    }

    private static String directive(CharSequence s, int i) {
        int e = i + 1;
        while (e < s.length() && Character.isLetter(s.charAt(e))) e++;
        return s.subSequence(i, e).toString().toUpperCase();
    }

    private static int indexOfWord(CharSequence s, String word, int from) {
        String u = s.toString().toUpperCase();
        int i = u.indexOf(word, from);
        while (i >= 0 && i + word.length() < u.length() && Character.isLetterOrDigit(u.charAt(i + word.length()))) {
            i = u.indexOf(word, i + 1);
        }
        return i;
    }

    /** Replaces s[a, b) with spaces, one per UTF-8 byte, keeping line breaks; returns the growth. */
    private static int blank(StringBuilder s, int a, int b) {
        StringBuilder r = new StringBuilder();
        for (int i = a; i < b; i++) {
            char c = s.charAt(i);
            if (c == '\n' || c == '\r') {
                r.append(c);
            } else if (Character.isHighSurrogate(c)) {
                r.append("    ");
                i++;
            } else {
                r.append(" ".repeat(c < 0x80 ? 1 : c < 0x800 ? 2 : 3));
            }
        }
        s.replace(a, b, r.toString());
        return r.length() - (b - a);
    }

    private boolean inConditionalBytes(int byteOffset) {
        if (conditional.isEmpty()) return false;
        int cp = Arrays.binarySearch(byteOf, byteOffset);
        return cp >= 0 && inConditional(charOf[cp]);
    }

    /** Whether a UTF-16 index lies in a conditional compilation block. */
    private boolean inConditional(int charIndex) {
        for (int[] b : conditional) {
            if (b[0] <= charIndex && charIndex < b[1]) return true;
        }
        return false;
    }

    private String run() {
        SyntaxErrorListener el = new SyntaxErrorListener();
        IslandSqlLexer lexer = new IslandSqlLexer(CharStreams.fromString(src));
        lexer.setDialect(IslandSqlDialect.ORACLEDB);
        lexer.removeErrorListeners();
        lexer.addErrorListener(el);
        IslandSqlParser parser = new IslandSqlParser(new CommonTokenStream(lexer));
        parser.removeErrorListeners();
        parser.addErrorListener(el);
        ParseTree file = parser.file();

        List<String> errors = new ArrayList<>();
        for (SyntaxErrorEntry e : el.getSyntaxErrors()) {
            errors.add(q(e.getLine() + ":" + e.getCharPositionInLine() + " " + e.getMessage()));
        }
        if (errors.isEmpty()) {
            walk(file, null);
        }
        return "{\"path\":" + q(path.toString()) + ",\"errors\":[" + String.join(",", errors) + "],\"units\":["
                + String.join(",", units) + "],\"points\":[" + String.join(",", points) + "],\"loops\":[" + String.join(",", loops) + "],\"skipped\":" + skipped + "}";
    }

    // ---- tree walk -------------------------------------------------------

    private static final Map<String, String> UNIT_TYPES = Map.of(
            "CreatePackageBodyContext", "PACKAGE BODY",
            "CreateProcedureContext", "PROCEDURE",
            "CreateFunctionContext", "FUNCTION",
            "CreateTypeBodyContext", "TYPE BODY",
            "CreateTriggerContext", "TRIGGER");

    private void walk(ParseTree t, String sub) {
        if (t instanceof ParserRuleContext ctx) {
            String cls = ctx.getClass().getSimpleName();
            String unitType = UNIT_TYPES.get(cls);
            if (unitType != null) {
                unit = units.size();
                units.add("{\"type\":" + q(unitType) + ",\"name\":" + q(unitName(ctx)) + ",\"start\":" + start(ctx)
                        + ",\"end\":" + end(ctx) + ",\"decl\":" + declOffset(ctx, unitType) + "}");
            }
            if (ctx instanceof IslandSqlParser.FunctionDefinitionContext || ctx instanceof IslandSqlParser.ProcedureDefinitionContext) {
                sub = subprogramName(ctx, sub);
            }
            if (unit >= 0) {
                if (ctx instanceof IslandSqlParser.SimpleComparisonConditionContext c) {
                    ror(c, sub);
                } else if (ctx instanceof IslandSqlParser.LogicalConditionContext c) {
                    lcr(c, sub);
                } else if (AOR.containsKey(cls)) {
                    aor(ctx, cls, sub);
                } else if (ctx instanceof IslandSqlParser.PlsqlStatementContext s) {
                    sbr(s, sub);
                } else if (ctx instanceof IslandSqlParser.BodyContext b) {
                    ret(b, sub);
                }
                if (LOOPS.contains(cls)) {
                    loop(ctx);
                }
                switch (cls) {
                    case "ExceptionHandlerContext" -> exc(ctx, sub);
                    case "IsNullConditionContext" -> nulCondition(ctx, sub);
                    case "FunctionExpressionContext" -> nulFunction(ctx, sub);
                    case "ModuloExpressionContext" -> curAttribute(ctx, sub);
                    case "SteppedControlContext" -> curBounds(ctx, sub);
                    case "ConcatenationExpressionContext" -> concat(ctx, sub);
                    default -> {}
                }
            }
        }
        for (int i = 0; i < t.getChildCount(); i++) {
            walk(t.getChild(i), sub);
        }
    }

    // ---- operators -------------------------------------------------------

    /** Sufficient ROR replacements (Kaminski, Ammann, Offutt), as in gomutant. */
    private static final Map<String, String[]> ROR = Map.of(
            "<", new String[]{"<=", "<>", "FALSE"},
            "<=", new String[]{"<", "=", "TRUE"},
            ">", new String[]{">=", "<>", "FALSE"},
            ">=", new String[]{">", "=", "TRUE"},
            "=", new String[]{"<=", ">=", "FALSE"},
            "<>", new String[]{"<", ">", "TRUE"});

    private void ror(IslandSqlParser.SimpleComparisonConditionContext c, String sub) {
        if (c.getChildCount() != 3 || !(c.getChild(1) instanceof ParserRuleContext opCtx)) {
            return;
        }
        String op = text(opCtx).replaceAll("\\s+", "");
        if (op.equals("!=") || op.equals("^=") || op.equals("~=")) {
            op = "<>";
        }
        String[] repl = ROR.get(op);
        if (repl == null) {
            return;
        }
        String before = src.substring(charOf[c.getStart().getStartIndex()], charOf[opCtx.getStart().getStartIndex()]);
        String after = src.substring(charOf[opCtx.getStop().getStopIndex() + 1], charOf[c.getStop().getStopIndex() + 1]);
        String left = before.strip(), right = after.strip();
        if (isLiteral(left) && isLiteral(right)) {
            skipped += repl.length; // constant comparison
            return;
        }
        // Codes compared with a string literal are categories, not an order:
        // only TRUE and FALSE, as gomutant does for named constants.
        if ((op.equals("=") || op.equals("<>")) && (isStringLiteral(left) || isStringLiteral(right))) {
            skipped += 1;
            repl = new String[]{"TRUE", "FALSE"};
        }
        // A value that is never negative compared with 0 has one equivalent variant.
        String equivalent = null;
        if (right.equals("0") && nonNegative(left)) equivalent = EQUIV_ZERO_RIGHT.get(op);
        if (left.equals("0") && nonNegative(right)) equivalent = EQUIV_ZERO_LEFT.get(op);
        List<String> mutants = new ArrayList<>();
        for (String r : repl) {
            if (r.equals(equivalent)) {
                skipped++;
                continue;
            }
            mutants.add(r.equals("TRUE") || r.equals("FALSE") ? r : before + r + after);
        }
        String cat = guardsRaise(c) ? "pruefung" : "";
        point("ROR", "bool", c, sub, context(c), cat, mutants);
    }

    // x > 0 equals x <> 0 for x >= 0, and so on (gomutant's equivZero tables).
    private static final Map<String, String> EQUIV_ZERO_RIGHT = Map.of("<>", ">", "=", "<=", ">", "<>", "<=", "=");
    private static final Map<String, String> EQUIV_ZERO_LEFT = Map.of("<>", "<", "=", ">=", "<", "<>", ">=", "=");
    private static final java.util.regex.Pattern NON_NEGATIVE = java.util.regex.Pattern.compile(
            "(?is)^(LENGTH|LENGTHB|LENGTHC|COUNT|INSTR|INSTRB|ABS|DBMS_LOB\\.GETLENGTH|CARDINALITY)\\s*\\(.*\\)$"
                    + "|^[\\w$#.\"]+\\.COUNT(\\s*\\(\\s*\\))?$|^[\\w$#.\"]+%ROWCOUNT$");

    private static boolean nonNegative(String e) {
        return NON_NEGATIVE.matcher(e).matches();
    }

    private static boolean isStringLiteral(String e) {
        return e.length() >= 2 && e.startsWith("'") && e.endsWith("'") && e.indexOf('\'', 1) == e.length() - 1
                || e.matches("(?s)'([^']|'')*'");
    }

    private static boolean isLiteral(String e) {
        return isStringLiteral(e) || e.matches("-?\\d+(\\.\\d+)?") || e.equalsIgnoreCase("NULL")
                || e.equalsIgnoreCase("TRUE") || e.equalsIgnoreCase("FALSE");
    }

    private static final Set<String> LOOPS = Set.of("BasicLoopStatementContext", "WhileLoopStatementContext",
            "ForLoopStatementContext", "CursorForLoopStatementContext");

    /** Records the offset right after the LOOP keyword, where a loop guard goes. */
    private void loop(ParserRuleContext c) {
        for (int i = 0; i < c.getChildCount(); i++) {
            if (c.getChild(i) instanceof TerminalNode t && t.getText().equalsIgnoreCase("LOOP")) {
                if (inConditionalBytes(byteOf[t.getSymbol().getStopIndex() + 1])) return;
                loops.add("{\"unit\":" + unit + ",\"at\":" + byteOf[t.getSymbol().getStopIndex() + 1] + "}");
                return;
            }
        }
    }

    /** EXC: the handler swallows the exception (its statements become NULL). */
    private void exc(ParserRuleContext h, String sub) {
        List<ParserRuleContext> stmts = new ArrayList<>();
        for (int i = 0; i < h.getChildCount(); i++) {
            if (h.getChild(i) instanceof IslandSqlParser.PlsqlStatementContext st) stmts.add(st);
        }
        if (stmts.isEmpty()) return;
        if (stmts.size() == 1 && SBR_KINDS.contains(lastChild(stmts.get(0)))) return; // same mutant as SBR
        ParserRuleContext first = stmts.get(0), last = stmts.get(stmts.size() - 1);
        int a = charOf[first.getStart().getStartIndex()], e = charOf[last.getStop().getStopIndex() + 1];
        String body = src.substring(a, e);
        if (body.replaceAll("\\s+", "").equalsIgnoreCase("NULL;")) return; // swallows already
        pointSpan("EXC", "stmt", byteOf[first.getStart().getStartIndex()], byteOf[last.getStop().getStopIndex() + 1],
                body, sub, "plsql", "fehlerpfad", List.of("NULL;"));
    }

    private static final Set<String> SBR_KINDS = Set.of("AssignmentStatementContext", "SqlStatementContext",
            "ProcedureCallContext", "RaiseStatementContext", "ExitStatementContext");

    private static String lastChild(ParserRuleContext s) {
        String kind = "";
        for (int i = 0; i < s.getChildCount(); i++) {
            if (s.getChild(i) instanceof ParserRuleContext c) kind = c.getClass().getSimpleName();
        }
        return kind;
    }

    /** NUL: IS NULL and IS NOT NULL swap. */
    private void nulCondition(ParserRuleContext c, String sub) {
        if (c.getChildCount() < 3 || !(c.getChild(0) instanceof ParserRuleContext operand)) return;
        // IslandSQL 0.26 parses "x AND y IS NULL" as "(x AND y) IS NULL"; such nodes are skipped.
        if (operand.getClass().getSimpleName().contains("Condition")) return;
        Token is = null, not = null;
        for (int i = 1; i < c.getChildCount(); i++) {
            if (c.getChild(i) instanceof TerminalNode t) {
                String u = t.getText().toUpperCase();
                if (u.equals("IS") && is == null) is = t.getSymbol();
                if (u.equals("NOT") && not == null) not = t.getSymbol();
            }
        }
        if (is == null) return;
        int a = charOf[c.getStart().getStartIndex()], e = charOf[c.getStop().getStopIndex() + 1];
        String m;
        if (not != null) {
            int ns = charOf[not.getStartIndex()], ne = charOf[not.getStopIndex() + 1];
            while (ne < e && Character.isWhitespace(src.charAt(ne))) ne++;
            m = src.substring(a, ns) + src.substring(ne, e);
        } else {
            int ie = charOf[is.getStopIndex() + 1];
            m = src.substring(a, ie) + " NOT" + src.substring(ie, e);
        }
        point("NUL", "bool", c, sub, context(c), guardsRaise(c) ? "pruefung" : "", List.of(m));
    }

    /** NUL: NVL(a, b) gives a or b; COALESCE drops its first argument or keeps only it. */
    private void nulFunction(ParserRuleContext f, String sub) {
        String name = f.getStart().getText().toUpperCase();
        if (name.equals("MOD")) {
            List<String> args = new ArrayList<>();
            for (int i = 0; i < f.getChildCount(); i++) {
                if (f.getChild(i) instanceof ParserRuleContext pc && pc.getClass().getSimpleName().equals("FunctionParameterContext")) {
                    args.add(text(pc));
                }
            }
            if (args.size() == 2) {
                point("AOR", "value", f, sub, context(f), "", List.of("(" + args.get(0) + ") * (" + args.get(1) + ")"));
            }
            return;
        }
        if (!name.equals("NVL") && !name.equals("COALESCE")) return;
        List<String> args = new ArrayList<>();
        for (int i = 0; i < f.getChildCount(); i++) {
            ParseTree ch = f.getChild(i);
            if (ch instanceof ParserRuleContext pc && pc.getClass().getSimpleName().equals("FunctionParameterContext")) {
                args.add(text(pc));
            }
        }
        if (args.size() < 2 || (name.equals("NVL") && args.size() != 2)) return;
        List<String> mutants = new ArrayList<>();
        mutants.add(args.get(0));
        if (args.size() == 2) {
            mutants.add(args.get(1));
        } else {
            mutants.add(f.getStart().getText() + "(" + String.join(", ", args.subList(1, args.size())) + ")");
        }
        point("NUL", "value", f, sub, context(f), "", mutants);
    }

    /**
     * AOR for strings: a || b becomes a. || shares its precedence with + and
     * -, which IslandSQL nests wrongly, so mixed chains are left out; pure
     * chains are safe because concatenation is associative.
     */
    private void concat(ParserRuleContext c, String sub) {
        if (c.getChildCount() != 3 || !(c.getChild(0) instanceof ParserRuleContext left)
                || !(c.getChild(2) instanceof ParserRuleContext right)) return;
        for (ParserRuleContext x : List.of(left, right, c.getParent())) {
            String n = x.getClass().getSimpleName();
            if (n.startsWith("Addition") || n.startsWith("Substraction")) return;
        }
        point("AOR", "value", c, sub, context(c), "", List.of(text(left)));
    }

    /** CUR: cursor%FOUND and %NOTFOUND swap (IslandSQL reads them as modulo). */
    private void curAttribute(ParserRuleContext c, String sub) {
        if (c.getChildCount() != 3) return;
        String attr = text((ParserRuleContext) c.getChild(2)).toUpperCase();
        String swapped = switch (attr) {
            case "FOUND" -> "NOTFOUND";
            case "NOTFOUND" -> "FOUND";
            default -> null;
        };
        if (swapped == null || !(c.getChild(0) instanceof ParserRuleContext cursor)) return;
        point("CUR", "bool", c, sub, "plsql", "", List.of(text(cursor) + "%" + swapped));
    }

    /** CUR: a FOR loop loses its first or its last iteration. */
    private void curBounds(ParserRuleContext c, String sub) {
        List<ParserRuleContext> bounds = new ArrayList<>();
        for (int i = 0; i < c.getChildCount(); i++) {
            if (c.getChild(i) instanceof ParserRuleContext pc) bounds.add(pc);
            else if (c.getChild(i) instanceof TerminalNode t && t.getText().equalsIgnoreCase("BY")) return;
        }
        if (bounds.size() != 2) return;
        ParserRuleContext lo = bounds.get(0), hi = bounds.get(1);
        point("CUR", "value", lo, sub, "plsql", "", List.of("(" + text(lo) + ") + 1"));
        point("CUR", "value", hi, sub, "plsql", "", List.of("(" + text(hi) + ") - 1"));
    }

    /** Non-redundant LCR replacements (Just et al.), as in gomutant. */
    private void lcr(IslandSqlParser.LogicalConditionContext c, String sub) {
        if (c.operator == null || c.left == null || c.right == null) return;
        // IslandSQL 0.26 nests "a BETWEEN x AND y AND b" and "a IS NOT NULL AND b IS OF (t)"
        // wrongly: the AND ends up as operand of BETWEEN / IS OF. A logical condition is
        // only trusted below another logical condition, NOT, or a non-condition node.
        String parent = c.getParent().getClass().getSimpleName();
        if (parent.contains("Condition") && !parent.startsWith("Logical") && !parent.startsWith("NotCondition")) return;
        String op = c.operator.getText().toUpperCase();
        String l = text(c.left), r = text(c.right);
        List<String> mutants = switch (op) {
            case "AND" -> new ArrayList<>(List.of(l, r, "(" + l + ") = (" + r + ")", "FALSE"));
            case "OR" -> new ArrayList<>(List.of(l, r, "(" + l + ") <> (" + r + ")", "TRUE"));
            default -> null;
        };
        if (mutants == null) return;
        // v = A OR v = B with different constants cannot both hold: <> equals OR.
        if (op.equals("OR") && exclusiveEquals(c.left, c.right)) {
            mutants.remove(2);
            skipped++;
        }
        point("LCR", "bool", c, sub, context(c), guardsRaise(c) ? "pruefung" : "", mutants);
    }

    private boolean exclusiveEquals(ParserRuleContext x, ParserRuleContext y) {
        String[] a = equalsParts(x), b = equalsParts(y);
        return a != null && b != null && a[0].equalsIgnoreCase(a[0]) && a[0].equalsIgnoreCase(b[0])
                && isLiteral(a[1]) && isLiteral(b[1]) && !a[1].equals(b[1]);
    }

    /** For "v = literal" (or "literal = v") returns {v, literal}, else null. */
    private String[] equalsParts(ParserRuleContext e) {
        while (e.getChildCount() == 1 && e.getChild(0) instanceof ParserRuleContext only) e = only;
        if (!(e instanceof IslandSqlParser.SimpleComparisonConditionContext c) || c.getChildCount() != 3
                || !(c.getChild(1) instanceof ParserRuleContext op) || !text(op).strip().equals("=")) return null;
        String l = text((ParserRuleContext) c.getChild(0)).strip(), r = text((ParserRuleContext) c.getChild(2)).strip();
        if (isLiteral(r)) return new String[]{l, r};
        if (isLiteral(l)) return new String[]{r, l};
        return null;
    }

    private static final Map<String, String[]> AOR = Map.of(
            "AdditionExpressionContext", new String[]{"+", "-"},
            "SubstractionExpressionContext", new String[]{"-", "+"},
            "MultiplicationExpressionContext", new String[]{"*", "/"},
            "DivisionExpressionContext", new String[]{"/", "*"});

    /**
     * Arithmetic operator replacement: + and - swap, * and / swap.
     *
     * IslandSQL 0.26 gives + a higher precedence than - (and * than /), so
     * "a - b + c" comes out as a - (b + c). Oracle evaluates operators of one
     * level left to right. We therefore flatten each chain of one level into
     * operands and operators and build the left-associative spans ourselves:
     * the k-th operator's point covers operands 0..k.
     */
    private void aor(ParserRuleContext c, String cls, String sub) {
        if (AOR.containsKey(c.getParent().getClass().getSimpleName()) && sameLevel(cls, c.getParent().getClass().getSimpleName())) {
            return; // not the root of the chain
        }
        List<ParserRuleContext> operands = new ArrayList<>();
        List<Token> ops = new ArrayList<>();
        flatten(c, cls, operands, ops);
        if (operands.size() != ops.size() + 1) return;
        int a = charOf[operands.get(0).getStart().getStartIndex()];
        for (int k = 0; k < ops.size(); k++) {
            Token op = ops.get(k);
            ParserRuleContext last = operands.get(k + 1);
            int o = charOf[op.getStartIndex()];
            int e = charOf[last.getStop().getStopIndex() + 1];
            String swapped = switch (op.getText()) {
                case "+" -> "-";
                case "-" -> "+";
                case "*" -> "/";
                default -> "*";
            };
            String m = src.substring(a, o) + swapped + src.substring(o + 1, e);
            int startB = byteOf[operands.get(0).getStart().getStartIndex()], endB = byteOf[last.getStop().getStopIndex() + 1];
            pointSpan("AOR", "value", startB, endB, src.substring(a, e), sub, context(c), "", List.of(m));
        }
    }

    private static boolean sameLevel(String a, String b) {
        boolean addA = a.startsWith("Addition") || a.startsWith("Substraction");
        boolean addB = b.startsWith("Addition") || b.startsWith("Substraction");
        return AOR.containsKey(a) && AOR.containsKey(b) && addA == addB;
    }

    private static void flatten(ParserRuleContext c, String rootCls, List<ParserRuleContext> operands, List<Token> ops) {
        for (int i = 0; i < c.getChildCount(); i++) {
            ParseTree ch = c.getChild(i);
            if (ch instanceof TerminalNode t) {
                String x = t.getText();
                if (x.equals("+") || x.equals("-") || x.equals("*") || x.equals("/")) ops.add(t.getSymbol());
            } else if (ch instanceof ParserRuleContext pc) {
                String n = pc.getClass().getSimpleName();
                if (AOR.containsKey(n) && sameLevel(rootCls, n)) {
                    flatten(pc, rootCls, operands, ops);
                } else {
                    operands.add(pc);
                }
            }
        }
    }

    /** Extreme mutation: the subprogram returns at once (functions return NULL). */
    private void ret(IslandSqlParser.BodyContext b, String sub) {
        ParserRuleContext def = b.getParent();
        String repl;
        if (def instanceof IslandSqlParser.FunctionDefinitionContext) {
            repl = "RETURN NULL;";
        } else if (def instanceof IslandSqlParser.ProcedureDefinitionContext) {
            repl = "RETURN;";
        } else {
            return;
        }
        // Second variant: the subprogram fails at once (Descartes' exception variant).
        String raise = "RAISE_APPLICATION_ERROR(-20998, 'plmut: RET');";
        Token begin = b.getStart();
        if (!begin.getText().equalsIgnoreCase("BEGIN")) return;
        int at = byteOf[begin.getStopIndex() + 1];
        if (inConditionalBytes(at)) return;
        points.add("{\"unit\":" + unit + ",\"op\":\"RET\",\"kind\":\"insert\",\"sub\":" + q(sub == null ? "" : sub)
                + ",\"ctx\":\"plsql\",\"cat\":\"funktion\",\"start\":" + at + ",\"end\":" + at
                + ",\"orig\":\"\",\"mutants\":[" + q(" " + repl) + "," + q(" " + raise) + "]}");
    }

    /** Statement removal for simple statements; RETURN, NULL and control flow stay. */
    private void sbr(IslandSqlParser.PlsqlStatementContext s, String sub) {
        ParserRuleContext stmt = null;
        for (int i = 0; i < s.getChildCount(); i++) {
            if (s.getChild(i) instanceof ParserRuleContext c) {
                stmt = c;
            }
        }
        if (stmt == null) {
            return;
        }
        String kind = stmt.getClass().getSimpleName();
        String cat = "";
        switch (kind) {
            case "AssignmentStatementContext", "SqlStatementContext" -> {}
            case "ProcedureCallContext" -> {
                if (isRaiseCall(stmt)) cat = "fehlerpfad";
            }
            case "RaiseStatementContext" -> cat = "fehlerpfad";
            case "ExitStatementContext" -> {
                if (!text(stmt).toUpperCase().matches("(?s).*\\bWHEN\\b.*")) return; // plain EXIT: endless loop
            }
            default -> { return; }
        }
        String repl = stmt.getStop().getText().equals(";") ? "NULL;" : "NULL";
        point("SBR", "stmt", stmt, sub, context(s), cat, List.of(repl));
    }

    private void point(String op, String kind, ParserRuleContext ctx, String sub, String context, String cat, List<String> mutants) {
        pointSpan(op, kind, start(ctx), end(ctx), text(ctx), sub, context, cat, mutants);
    }

    private void pointSpan(String op, String kind, int startB, int endB, String orig, String sub, String context, String cat, List<String> mutants) {
        if (inConditionalBytes(startB)) return;
        StringBuilder m = new StringBuilder();
        for (String r : mutants) {
            if (m.length() > 0) m.append(',');
            m.append(q(r));
        }
        points.add("{\"unit\":" + unit + ",\"op\":" + q(op) + ",\"kind\":" + q(kind) + ",\"sub\":" + q(sub == null ? "" : sub)
                + ",\"ctx\":" + q(context) + ",\"cat\":" + q(cat) + ",\"start\":" + startB + ",\"end\":" + endB
                + ",\"orig\":" + q(orig) + ",\"mutants\":[" + m + "]}");
    }

    // ---- helpers ---------------------------------------------------------

    /** "sql" inside an embedded SQL statement or cursor, else "plsql". */
    private static String context(ParserRuleContext c) {
        for (ParserRuleContext p = c.getParent(); p != null; p = p.getParent()) {
            String n = p.getClass().getSimpleName();
            if (n.equals("SqlStatementContext") || n.equals("CursorDefinitionContext") || n.equals("CursorDeclarationContext")
                    || n.equals("QueryBlockContext") || n.equals("SubqueryContext")) {
                return "sql";
            }
            if (n.equals("PlsqlStatementContext") || n.equals("BodyContext")) {
                return "plsql";
            }
        }
        return "plsql";
    }

    /** True if the comparison is part of an IF condition whose branch raises. */
    private static boolean guardsRaise(ParserRuleContext c) {
        for (ParserRuleContext p = c.getParent(); p != null; p = p.getParent()) {
            if (p.getClass().getSimpleName().equals("ConditionToStatementsContext")) {
                return containsRaise(p);
            }
            if (p instanceof IslandSqlParser.PlsqlStatementContext) {
                return false;
            }
        }
        return false;
    }

    private static boolean containsRaise(ParseTree t) {
        if (t instanceof IslandSqlParser.RaiseStatementContext) return true;
        if (t instanceof ParserRuleContext c && c.getClass().getSimpleName().equals("ProcedureCallContext") && isRaiseCall(c)) return true;
        for (int i = 0; i < t.getChildCount(); i++) {
            if (containsRaise(t.getChild(i))) return true;
        }
        return false;
    }

    private static boolean isRaiseCall(ParserRuleContext call) {
        return call.getStart().getText().equalsIgnoreCase("raise_application_error");
    }

    private String unitName(ParserRuleContext create) {
        // The name is the qualified name after the unit keywords and before IS/AS.
        List<Token> toks = new ArrayList<>();
        terminals(create, toks);
        Set<String> skip = Set.of("CREATE", "OR", "REPLACE", "EDITIONABLE", "NONEDITIONABLE", "PACKAGE", "BODY",
                "PROCEDURE", "FUNCTION", "TYPE", "TRIGGER", "IF", "NOT", "EXISTS");
        StringBuilder name = new StringBuilder();
        for (Token t : toks) {
            String u = t.getText().toUpperCase();
            if (name.length() == 0 && skip.contains(u)) continue;
            if (u.equals("IS") || u.equals("AS") || u.equals("(") || u.equals("RETURN") || u.equals("AUTHID")
                    || u.equals("BEFORE") || u.equals("AFTER") || u.equals("INSTEAD") || u.equals("FOR")
                    || u.equals("SHARING") || u.equals("ACCESSIBLE") || u.equals("DEFAULT")) break;
            name.append(t.getText());
        }
        return name.toString();
    }

    /** For package bodies the offset right after IS/AS, where declarations may go; else -1. */
    private int declOffset(ParserRuleContext create, String unitType) {
        if (!unitType.equals("PACKAGE BODY")) return -1;
        List<Token> toks = new ArrayList<>();
        terminals(create, toks);
        for (Token t : toks) {
            String u = t.getText().toUpperCase();
            if (u.equals("IS") || u.equals("AS")) return byteOf[t.getStopIndex() + 1];
        }
        return -1;
    }

    private static String subprogramName(ParserRuleContext def, String outer) {
        List<Token> toks = new ArrayList<>();
        terminals(def.getChild(0), toks);
        String name = toks.size() > 1 ? toks.get(1).getText() : "?";
        return outer == null ? name : outer + "." + name;
    }

    private static void terminals(ParseTree t, List<Token> acc) {
        if (t instanceof TerminalNode n) {
            acc.add(n.getSymbol());
            return;
        }
        for (int i = 0; i < t.getChildCount(); i++) terminals(t.getChild(i), acc);
    }

    private int start(ParserRuleContext c) { return byteOf[c.getStart().getStartIndex()]; }

    private int end(ParserRuleContext c) { return byteOf[c.getStop().getStopIndex() + 1]; }

    private String text(ParserRuleContext c) {
        return src.substring(charOf[c.getStart().getStartIndex()], charOf[c.getStop().getStopIndex() + 1]);
    }

    static String q(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> { if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c); }
            }
        }
        return b.append('"').toString();
    }
}
